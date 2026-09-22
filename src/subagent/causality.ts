import type { SessionSnapshot, CommittedSessionEvent } from '../session/types.js'
import { sessionLogPosition } from '../session/ids.js'
import type { DelegationRequested } from './event-contract.js'
import { projectAgentSession } from '../agent/projection.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import { equal } from '../agent/validation.js'
import { childSettlementObservation } from './observation.js'
import { SubagentError } from './errors.js'

/** Validate physical cross-log evidence. A receiver may be ahead of an ACK, never ahead of the sender's accepted message. */
export function validateDelegationCausality(parent: SessionSnapshot, child: SessionSnapshot | null, requested: CommittedSessionEvent<DelegationRequested>): void {
  const state = projectAgentSession(parent)
  const observations = state.subagents.observations.filter(item => item.payload.delegation === requested.stored.eventId)
  const provision = state.subagents.provisions.find(item => item.payload.delegation === requested.stored.eventId)?.payload
  if (child === null) {
    if (observations.length > 0 || provision?.outcome === 'installed') invalid('referenced-child-missing')
    return
  }
  for (const observed of observations) {
    const through = observed.payload.childThrough
    if (through > child.localPosition) invalid('observation-beyond-child-log')
    const events = child.history.at(-1)!.events.slice(0, through)
    const lifecycle = events.at(-1)?.stored.type === 'session/ended' ? 'ended' : 'active'
    const prefix: SessionSnapshot = { ...child, lifecycle, localPosition: sessionLogPosition(through),
      history: [{ ...child.history.at(-1)!, through: sessionLogPosition(through), localLifecycle: lifecycle, events }] }
    if (!equal(childSettlementObservation({ event: requested }, prefix), observed.payload)) invalid('observation-child-prefix-mismatch')
  }
  const parentFacts = projectCommunicationFacts(parent); const childFacts = projectCommunicationFacts(child)
  for (const [sender, receiver] of [[parentFacts, childFacts], [childFacts, parentFacts]] as const) {
    for (const incoming of receiver.inbox.filter(item => item.envelope.channelId === requested.payload.channelId)) {
      const outgoing = sender.outbox.find(item => equal(item.envelope, incoming.envelope))
      if (outgoing === undefined) invalid('inbox-without-sender-acceptance')
      if (outgoing.attemptCount === 0) invalid('inbox-before-sender-emission')
    }
    for (const outgoing of sender.outbox.filter(item => item.envelope.channelId === requested.payload.channelId && item.status === 'delivered')) {
      if (!receiver.inbox.some(item => equal(item.envelope, outgoing.envelope))) invalid('delivery-without-receiver-acceptance')
    }
  }
  if (provision?.outcome === 'installed' && provision.child !== null) {
    const refs = Object.values(provision.child)
    if (refs.some(id => !child.history.at(-1)!.events.some(item => item.stored.eventId === id))) invalid('provision-child-prefix-missing')
  }
}
function invalid(reason: string): never { throw new SubagentError('SUBAGENT_STATE_INVALID', reason) }

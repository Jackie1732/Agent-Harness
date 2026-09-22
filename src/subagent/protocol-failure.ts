import type { SessionHandle } from '../session/session-handle.js'
import type { SessionMailbox } from '../communication/mailbox.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { AgentJournal } from '../agent/journal.js'
import { projectAgentSession } from '../agent/projection.js'
import type { AcceptedDelegation } from './admission.js'
import type { ProtocolAction } from './protocol-maintenance.js'
import { subagentDeliveryFailedEvent } from './session-events.js'

/** Permanent delivery failures and accepted cancellation settle original intents without resending their content. */
export function protocolFailureAction(accepted: AcceptedDelegation, session: SessionHandle, journal: AgentJournal,
  mailbox: SessionMailbox, stopped: boolean): ProtocolAction | undefined {
  const state = projectAgentSession(session.snapshot())
  const facts = projectCommunicationFacts(session.snapshot())
  for (const intent of state.subagents.protocol.filter(item => item.payload.delegation === accepted.event.stored.eventId)) {
    if (state.subagents.failures.some(item => item.payload.protocol === intent.stored.eventId)) continue
    const outgoing = facts.outbox.find(item => item.sendKey?.eventId === intent.stored.eventId && item.sendKey.index === 0)
    const identity = { delegation: accepted.event.stored.eventId, parentAddress: accepted.event.payload.parentAddress, childAddress: accepted.event.payload.childAddress }
    if (outgoing?.status === 'rejected' || outgoing?.status === 'abandoned') return () => journal.append(subagentDeliveryFailedEvent, () => ({ ...identity,
      protocol: intent.stored.eventId, failure: 'outbox-terminal' as const, terminal: outgoing.terminalEventId, reasonCode: 'permanent-delivery-failure' }))
    if (!stopped || intent.payload.kind === 'result') continue
    if (outgoing === undefined) return () => journal.append(subagentDeliveryFailedEvent, () => ({ ...identity,
      protocol: intent.stored.eventId, failure: 'cancelled-before-send' as const, terminal: null, reasonCode: 'delegation-stopped' }))
    if (outgoing.status === 'pending') return () => mailbox.abandonOutgoing(outgoing.messageId, 'caller-requested')
  }
  return undefined
}

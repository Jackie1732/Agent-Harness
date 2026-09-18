import { expireAgentRoot } from './root-policy.js'
import { clockTimestamp } from '../foundation/clock.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { AgentRuntime } from './runtime-contract.js'
import type { AgentWaitState } from './state.js'
import { projectAgentSession } from './projection.js'
import { matchesAgentWait } from './projection-controls.js'
import { referenceKey } from './input-codec.js'
import * as events from './session-events.js'
import type { SessionSnapshot } from '../session/types.js'
import type { AgentSessionSnapshot } from './state.js'
import type { AgentWaitSettled } from './event-contract.js'

function takeManagement(runtime: AgentRuntime): boolean {
  if (runtime.management === undefined) return true
  if (runtime.management.remaining === 0) return false
  runtime.management.remaining--; return true
}

/** Receipt synchronization is separate from Agent input disposition and safe to resume. */
export async function synchronizeAgentReceipts(runtime: AgentRuntime): Promise<void> {
  if (runtime.mailbox === undefined) return
  const facts = projectCommunicationFacts(runtime.session.snapshot())
  for (const input of projectAgentSession(runtime.session.snapshot()).inputs) {
    if (input.message === null || !['handled', 'abandoned'].includes(input.status)
      || facts.inbox.find(item => item.messageId === input.message!.messageId)?.status !== 'pending') continue
    if (input.status === 'handled' && runtime.mailbox.snapshot().inbox.find(item => item.messageId === input.message!.messageId)?.supported !== true) continue
    if (!takeManagement(runtime)) return
    if (input.status === 'handled') await runtime.mailbox.markProcessed(input.message.messageId)
    else await runtime.mailbox.abandonIncoming(input.message.messageId, 'caller-requested')
  }
}

export async function settleAgentStops(runtime: AgentRuntime): Promise<void> {
  for (const control of projectAgentSession(runtime.session.snapshot()).controls) {
    const request = control.requested.payload
    if (control.settled !== null || control.supersededBy !== null || request.kind !== 'cancel-work' && request.kind !== 'expire-work') continue
    let state = projectAgentSession(runtime.session.snapshot())
    if (state.turns.some(turn => turn.root === request.root && turn.settled === null)) continue
    for (const wait of state.waits) {
      if (wait.settled === null && wait.created.payload.result.kind === 'wait' && wait.created.payload.result.descriptor.root === request.root) {
        if (!takeManagement(runtime)) return
        try {
          await runtime.journal.append(events.agentWaitSettledEvent, () => ({ wait: wait.reference, outcome: 'cancelled' as const, response: null,
            reason: request.reason, observedAt: clockTimestamp(runtime.clock), supportedMessages: [], outboxTerminal: null }))
        } catch (error) {
          if (runtime.journal.faulted || projectAgentSession(runtime.session.snapshot()).waits.find(item => referenceKey(item.reference) === referenceKey(wait.reference))?.settled === null) throw error
        }
      }
    }
    state = projectAgentSession(runtime.session.snapshot())
    const root = state.roots.find(root => root.id === request.root)!
    const reserved = state.inputs.find(input => input.reservedBy !== null && state.waits.some(wait => referenceKey(wait.reference) === referenceKey(input.reservedBy!)
      && wait.created.payload.result.kind === 'wait' && wait.created.payload.result.descriptor.root === root.id))
    if (!takeManagement(runtime)) return
    try {
      await runtime.journal.append(events.agentControlSettledEvent, () => ({ control: control.requested.stored.eventId, outcome: 'completed' as const, reason: request.reason,
      rootOutcome: root.outcome ?? (request.kind === 'expire-work' ? 'timed-out' : 'cancelled'),
      responseDisposition: reserved === undefined ? null : reserved.message === null ? 'not-adopted' as const : 'release-peer' as const }))
    } catch (error) {
      if (runtime.journal.faulted || projectAgentSession(runtime.session.snapshot()).controls.find(item => item.requested.stored.eventId === control.requested.stored.eventId)?.settled === null) throw error
    }
  }
}

/** Bounded wake-time work, with event acceptance times deciding on-time responses. */
export async function manageAgentWaits(runtime: AgentRuntime): Promise<void> {
  const spec = projectAgentSession(runtime.session.snapshot()).spec!.payload
  for (const root of projectAgentSession(runtime.session.snapshot()).roots) {
    if (root.outcome === null && root.stopControl === null && clockTimestamp(runtime.clock) >= root.deadline) {
      if (!takeManagement(runtime)) return
      await expireAgentRoot(runtime, root.id)
    }
  }
  await settleAgentStops(runtime)
  for (const wait of projectAgentSession(runtime.session.snapshot()).waits) {
    if (wait.settled !== null) continue
    const state = projectAgentSession(runtime.session.snapshot())
    if (state.turns.find(turn => turn.started.stored.eventId === wait.turn)?.settled?.payload.outcome !== 'waiting') continue
    const descriptor = wait.created.payload.result.kind === 'wait' ? wait.created.payload.result.descriptor : undefined
    if (descriptor === undefined || state.roots.find(root => root.id === descriptor.root)?.stopControl !== null) continue
    const supportedMessages = spec.messages.filter(kind => runtime.messageCatalog.resolve(kind.type, kind.payloadVersion) !== undefined).map(({ type, payloadVersion }) => ({ type, payloadVersion }))
    const match = findWaitResponse(runtime.session.snapshot(), state, wait, supportedMessages)
    const outgoing = descriptor.kind === 'reply' ? projectCommunicationFacts(runtime.session.snapshot()).outbox.find(item => item.acceptedEventId === descriptor.outboxEventId) : undefined
    const unavailable = outgoing !== undefined && (outgoing.status === 'abandoned' || outgoing.status === 'rejected')
    if (match !== undefined || unavailable || clockTimestamp(runtime.clock) >= descriptor.deadline) {
      if (!takeManagement(runtime)) return
      const observedAt = clockTimestamp(runtime.clock)
      await runtime.journal.append(events.agentWaitSettledEvent, (current, snapshot) => {
        const response = findWaitResponse(snapshot, current, wait, supportedMessages)
        const stopped = current.roots.find(root => root.id === descriptor.root)!.stopControl !== null
        return { wait: wait.reference, outcome: stopped ? 'cancelled' as const : response !== undefined ? 'matched' as const : unavailable ? 'unavailable' as const : 'timed-out' as const,
          response: stopped ? null : response?.reference ?? null, reason: stopped ? 'root-stopped' : response !== undefined ? 'response-matched' : unavailable ? 'outbound-unavailable' : 'wait-deadline',
          observedAt, supportedMessages, outboxTerminal: !stopped && response === undefined && unavailable && 'terminalEventId' in outgoing ? outgoing.terminalEventId : null }
      })
    }
  }
  await synchronizeAgentReceipts(runtime)
}

function findWaitResponse(snapshot: SessionSnapshot, state: AgentSessionSnapshot, wait: AgentWaitState, supported: AgentWaitSettled['supportedMessages']) {
  const sources = new Map(snapshot.history.at(-1)!.events.flatMap(item => item.kind === 'known' ? [[item.stored.eventId, item] as const] : []))
  const controls = new Map(state.controls.map(control => [control.requested.stored.eventId, control]))
  return state.inputs.find(input => matchesAgentWait(wait, input, { sources, controls }) && (input.message === null
    || supported.some(item => item.type === input.message!.type && item.payloadVersion === input.message!.payloadVersion)))
}

import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { AgentJournal } from './journal.js'
import { projectAgentSession } from './projection.js'
import { referenceKey } from './input-codec.js'
import * as events from './session-events.js'

/** One durable stop transition, including for a restored Agent with no execution resources. */
export function agentStopAction(session: SessionHandle, journal: AgentJournal, clock: Clock): (() => Promise<unknown>) | undefined {
  const state = projectAgentSession(session.snapshot())
  for (const control of state.controls) {
    const request = control.requested.payload
    if (control.settled !== null || control.supersededBy !== null || request.kind !== 'cancel-work' && request.kind !== 'expire-work') continue
    if (state.turns.some(turn => turn.root === request.root && turn.settled === null)) continue
    const wait = state.waits.find(wait => wait.settled === null && wait.created.payload.result.kind === 'wait' && wait.created.payload.result.descriptor.root === request.root)
    if (wait !== undefined) return async () => {
      try {
        await journal.append(events.agentExecutionEvents(state.spec!.payload.protocolVersion).waitSettled, () => ({
          wait: wait.reference, outcome: 'cancelled' as const, response: null, reason: request.reason,
          observedAt: clockTimestamp(clock), supportedMessages: [], outboxTerminal: null,
        }))
      } catch (cause) {
        const current = projectAgentSession(session.snapshot()).waits.find(item => referenceKey(item.reference) === referenceKey(wait.reference))
        if (journal.faulted || current?.settled == null) throw cause
      }
    }
    const root = state.roots.find(root => root.id === request.root)!
    const reserved = state.inputs.find(input => input.reservedBy !== null && state.waits.some(wait => referenceKey(wait.reference) === referenceKey(input.reservedBy!)
      && wait.created.payload.result.kind === 'wait' && wait.created.payload.result.descriptor.root === root.id))
    return async () => {
      try {
        await journal.append(events.agentControlSettledEvent, () => ({ control: control.requested.stored.eventId, outcome: 'completed' as const, reason: request.reason,
          rootOutcome: root.outcome ?? (request.kind === 'expire-work' ? 'timed-out' : 'cancelled'),
          responseDisposition: reserved === undefined ? null : reserved.message === null || reserved.protocol !== undefined ? 'not-adopted' as const : 'release-peer' as const,
        }))
      } catch (cause) {
        const current = projectAgentSession(session.snapshot()).controls.find(item => item.requested.stored.eventId === control.requested.stored.eventId)
        if (journal.faulted || current?.settled == null) throw cause
      }
    }
  }
  return undefined
}

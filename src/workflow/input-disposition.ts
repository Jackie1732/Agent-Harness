import type { AgentProjectionState } from '../agent/projection-state.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { Clock } from '../foundation/clock.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { eventId, exact, record } from '../agent/validation.js'
import { inputKey } from '../agent/input-codec.js'
import { foldAgentSession } from '../agent/projection.js'
import { AgentJournal } from '../agent/journal.js'
import { sameWorkflowValue } from './work-binding.js'
import { invalidHistory } from './errors.js'
import { workStopReceivedEvent } from './stop-events.js'
import { workProtocolClassifiedEvent } from './interaction-events.js'
import { workGroupResultEvent } from './group-events.js'
import type { SessionEventId } from '../session/ids.js'

/** A durable work decision disposes every claimed continuation of its terminal root. */
export function settleWorkRootInputs(state: AgentProjectionState, root: SessionEventId, reason: string): void {
  for (const turn of state.turns.values()) {
    if (turn.root !== root) continue
    const input = state.inputs.get(inputKey(turn.started.payload.input))!
    if (input.status === 'review-required') { input.status = 'not-adopted'; input.reason = reason }
  }
}

export const workInputUnadoptedEvent = createDurableEventDefinition({ type: 'work/input-unadopted', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value)
    if (p.root === null) {
      exact(p, ['input', 'root', 'stop'])
      return { input: eventId(p.input), root: null, stop: eventId(p.stop) }
    }
    exact(p, ['input', 'root'])
    return { input: eventId(p.input), root: eventId(p.root) }
  } })

/** Stopped roots dispose queued collaboration inputs without releasing them into another root. */
export function applyWorkInputUnadopted(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const p = workInputUnadoptedEvent.decode(event.payload), input = state.inputs.get(inputKey({ kind: 'workflow', eventId: p.input }))
  const assignment = input?.workMessage?.assignment ?? input?.workGroupResult?.assignment
  if (assignment === undefined || input === undefined || !['queued', 'review-required'].includes(input.status)) invalidHistory('work-input-unadopted-source')
  if (p.root === null) {
    const event = state.sources.get(p.stop)
    if (event?.stored.type !== workStopReceivedEvent.type) invalidHistory('work-input-stop-source')
    const stop = workStopReceivedEvent.decode(event.payload)
    if (stop.root !== null || !sameWorkflowValue(stop.assignment, assignment)) invalidHistory('work-input-stop-source')
  } else {
    const root = state.roots.get(p.root)
    if (root?.source.kind !== 'workflow' || root.outcome === null && root.stopControl === null
      || !sameWorkflowValue(assignment, root.source.assignment)) invalidHistory('work-input-unadopted-source')
  }
  input.status = 'not-adopted'; input.reason = 'work-root-terminal'
}

export function nextWorkInputDisposition(session: SessionHandle, clock: Clock): (() => Promise<unknown>) | undefined {
  const snapshot = session.snapshot()
  if (!snapshot.history.at(-1)!.events.some(item => [workProtocolClassifiedEvent.type, workGroupResultEvent.type].includes(item.stored.type))) return undefined
  const state = foldAgentSession(snapshot)
  for (const input of state.inputs.values()) {
    const assignment = input.workMessage?.assignment ?? input.workGroupResult?.assignment
    if (assignment === undefined || !['queued', 'review-required'].includes(input.status)) continue
    const root = [...state.roots.values()].find(root => root.source.kind === 'workflow' && sameWorkflowValue(root.source.assignment, assignment))
    if (root !== undefined && (root.outcome !== null || root.stopControl !== null)) return () => new AgentJournal(session, state.spec!.payload.limits.maxJournalConflicts, clock)
      .append(workInputUnadoptedEvent, () => ({ input: input.reference.eventId, root: root.id }))
    const stopped = [...state.sources.values()].find(item => item.stored.type === workStopReceivedEvent.type
      && workStopReceivedEvent.decode(item.payload).root === null && sameWorkflowValue(workStopReceivedEvent.decode(item.payload).assignment, assignment))
    if (root === undefined && stopped !== undefined) return () => new AgentJournal(session, state.spec!.payload.limits.maxJournalConflicts, clock)
      .append(workInputUnadoptedEvent, () => ({ input: input.reference.eventId, root: null, stop: stopped.stored.eventId }))
  }
  return undefined
}

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

export const workInputUnadoptedEvent = createDurableEventDefinition({ type: 'work/input-unadopted', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['input', 'root'])
    return { input: eventId(p.input), root: eventId(p.root) }
  } })

/** Stopped roots dispose queued collaboration inputs without releasing them into another root. */
export function applyWorkInputUnadopted(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const p = workInputUnadoptedEvent.decode(event.payload), input = state.inputs.get(inputKey({ kind: 'workflow', eventId: p.input })), root = state.roots.get(p.root)
  const assignment = input?.workMessage?.assignment ?? input?.workGroupResult?.assignment
  if (assignment === undefined || input?.status !== 'queued' || root?.source.kind !== 'workflow'
    || root.outcome === null && root.stopControl === null || !sameWorkflowValue(assignment, root.source.assignment)) invalidHistory('work-input-unadopted-source')
  input.status = 'not-adopted'; input.reason = 'work-root-terminal'
}

export function nextWorkInputDisposition(session: SessionHandle, clock: Clock): (() => Promise<unknown>) | undefined {
  const state = foldAgentSession(session.snapshot())
  for (const input of state.inputs.values()) {
    const assignment = input.workMessage?.assignment ?? input.workGroupResult?.assignment
    if (assignment === undefined || input.status !== 'queued') continue
    const root = [...state.roots.values()].find(root => root.source.kind === 'workflow' && sameWorkflowValue(root.source.assignment, assignment))
    if (root !== undefined && (root.outcome !== null || root.stopControl !== null)) return () => new AgentJournal(session, state.spec!.payload.limits.maxJournalConflicts, clock)
      .append(workInputUnadoptedEvent, () => ({ input: input.reference.eventId, root: root.id }))
  }
  return undefined
}

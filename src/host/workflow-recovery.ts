import type { SessionSnapshot } from '../session/types.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import type { Clock } from '../foundation/clock.js'
import type { RecoverHostOptions } from './recovery.js'
import { AgentJournal } from '../agent/journal.js'
import { foldAgentSession } from '../agent/projection.js'
import { sessionDelegationsClosed } from '../subagent/closure.js'
import { hasPendingLowerExecution } from '../subagent/execution-evidence.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { WorkflowJournal } from '../workflow/journal.js'
import { workAssignmentAcceptedEvent } from '../workflow/work-binding.js'
import { workExecutionReleasedEvent } from '../workflow/result-events.js'
import { workflowDefinitionRecordedEvent } from '../workflow/definition-events.js'
import { workRecoveryRequestedEvent, workRecoverySettledEvent, workflowRecoveryRequestedEvent, workflowRecoverySettledEvent } from '../workflow/recovery-events.js'
import { projectWorkRecoveries } from '../workflow/recovery-projection.js'
import { workflowControlSettledEvent } from '../workflow/control-events.js'
import { workInteractionSettlement } from '../workflow/interaction-settlement.js'
import { workflowInteractionSettledEvent } from '../workflow/interaction-events.js'

const events = (session: SessionHandle) => session.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known')
const isCoordinator = (session: SessionHandle) => events(session).some(item => item.stored.type === workflowDefinitionRecordedEvent.type)
const workKey = (session: Pick<SessionSnapshot, 'header'>, assignment: SessionEventId) => `work:${session.header.address}:${assignment}`
const coordinatorKey = (session: Pick<SessionSnapshot, 'header'>) => `workflow:${session.header.address}`

/** Every relation has a distinct predecessor, even when several domains share a physical journal. */
export function workflowRecoveryDomains(sessions: Iterable<SessionSnapshot>): ReadonlyMap<string, SessionEventId | null> {
  const domains = new Map<string, SessionEventId | null>()
  for (const session of sessions) {
    if (session.history.at(-1)!.events.some(item => item.stored.type === workflowDefinitionRecordedEvent.type)) {
      domains.set(coordinatorKey(session), projectWorkflowSession(session).recoveries.find(item => item.settled === null && item.supersededBy === null)?.requested.stored.eventId ?? null)
      continue
    }
    const local = session.history.at(-1)!.events.filter(item => item.kind === 'known'), recoveries = projectWorkRecoveries(local)
    for (const accepted of local.filter(item => item.stored.type === workAssignmentAcceptedEvent.type)) {
      const p = workAssignmentAcceptedEvent.decode(accepted.payload)
      domains.set(workKey(session, p.assignment.eventId), recoveries.find(item => item.requested.payload.accepted === accepted.stored.eventId
        && item.settled === null && item.supersededBy === null)?.requested.stored.eventId ?? null)
    }
  }
  return domains
}

/** Reconcile only saved relations after each Agent has had its single lower-domain recovery opportunity. */
export async function recoverWorkflowRelations(sessions: ReadonlyMap<string, SessionHandle>, remaining: () => number,
  pending: Set<string>, options: RecoverHostOptions, clock: Clock): Promise<void> {
  for (const session of sessions.values()) {
    if (isCoordinator(session)) continue
    const local = events(session)
    for (const accepted of local.filter(item => item.stored.type === workAssignmentAcceptedEvent.type)) {
      const binding = workAssignmentAcceptedEvent.decode(accepted.payload), key = workKey(session, binding.assignment.eventId)
      const state = foldAgentSession(session.snapshot())
      const recoveries = projectWorkRecoveries(state.sources.values()).filter(item => item.requested.payload.accepted === accepted.stored.eventId)
      const previous = recoveries.find(item => item.settled === null && item.supersededBy === null)
      const root = [...state.roots.values()].find(root => root.source.kind === 'workflow' && root.source.assignment.eventId === binding.assignment.eventId)
      const released = [...state.sources.values()].some(item => item.stored.type === workExecutionReleasedEvent.type
        && workExecutionReleasedEvent.decode(item.payload).accepted === accepted.stored.eventId && workExecutionReleasedEvent.decode(item.payload).outcome === 'released')
      if (previous === undefined && (root?.outcome == null || released)) continue
      const childrenClosed = sessionDelegationsClosed(state, [...state.sources.values()])
      if (previous === undefined && !childrenClosed && recoveries.some(item => item.settled !== null)) continue
      if (state.openRun !== null || state.openRecovery !== null || hasPendingLowerExecution(state.sources.values()) || remaining() < 2) { pending.add(key); continue }
      const journal = new AgentJournal(session, options.maxJournalConflicts, clock)
      const owner = await journal.append(workRecoveryRequestedEvent, (_, snapshot) => ({ assignment: binding.assignment, accepted: accepted.stored.eventId,
        through: snapshot.localPosition, predecessorStopped: true, supersedes: previous?.requested.stored.eventId ?? null, maxWrites: remaining() }))
      if (root?.outcome != null && !released && childrenClosed) {
        if (remaining() < 2) { pending.add(key); continue }
        await journal.append(workExecutionReleasedEvent, () => ({ assignment: binding.assignment, accepted: accepted.stored.eventId,
          root: root.id, recovery: owner.stored.eventId, outcome: 'released' as const }))
      }
      await journal.append(workRecoverySettledEvent, (_, snapshot) => ({ recovery: owner.stored.eventId, writes: snapshot.localPosition - owner.payload.through + 1 }))
    }
  }
  const byAddress = new Map([...sessions.values()].map(session => [session.header.address, session]))
  for (const coordinator of sessions.values()) {
    if (!isCoordinator(coordinator)) continue
    const nextInteraction = () => {
      for (const interaction of projectWorkflowSession(coordinator.snapshot()).interactions) {
        if (interaction.settled !== null) continue
        const sender = byAddress.get(interaction.admitted.payload.request.address)!
        const local = foldAgentSession(sender.snapshot())
        if (local.openRun !== null || local.openRecovery !== null) continue
        const settlement = workInteractionSettlement(local, interaction)
        if (settlement !== undefined) return settlement
      }
      return undefined
    }
    const state = projectWorkflowSession(coordinator.snapshot()), key = coordinatorKey(coordinator)
    const previous = state.recoveries.find(item => item.settled === null && item.supersededBy === null)
    if (previous === undefined && state.controls.every(item => item.settled !== null) && nextInteraction() === undefined) continue
    if (remaining() < 2) { pending.add(key); continue }
    const journal = new WorkflowJournal(coordinator, clock)
    const owner = await journal.append(workflowRecoveryRequestedEvent, () => ({ definition: state.definition!.stored.eventId,
      through: coordinator.snapshot().localPosition, predecessorStopped: true, supersedes: previous?.requested.stored.eventId ?? null, maxWrites: remaining() }))
    while (remaining() > 1) {
      const current = projectWorkflowSession(coordinator.snapshot())
      const control = current.controls.find(item => item.settled === null)
      if (control !== undefined) {
        const earlierCancel = current.controls.some(item => item.requested.stored.sequence < control.requested.stored.sequence
          && item.requested.payload.kind === 'cancel' && item.settled?.payload.outcome !== 'no-op')
        await journal.append(workflowControlSettledEvent, () => ({ request: control.requested.stored.eventId,
          outcome: current.stop !== null || current.terminal !== null || earlierCancel ? 'no-op' as const : 'applied' as const, owner: 'recovery:' + owner.stored.eventId }))
        continue
      }
      const settlement = nextInteraction()
      if (settlement === undefined) break
      await journal.append(workflowInteractionSettledEvent, () => settlement)
    }
    if (projectWorkflowSession(coordinator.snapshot()).controls.some(item => item.settled === null) || nextInteraction() !== undefined) { pending.add(key); continue }
    await journal.append(workflowRecoverySettledEvent, () => ({ recovery: owner.stored.eventId, writes: coordinator.snapshot().localPosition - owner.payload.through + 1 }))
  }
}

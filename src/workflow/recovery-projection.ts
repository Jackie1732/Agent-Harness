import type { CommittedSessionEvent } from '../session/types.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { source } from '../agent/projection-state.js'
import type { SessionEventId } from '../session/ids.js'
import { workRecoveryRequestedEvent, workRecoverySettledEvent, workflowRecoveryRequestedEvent, workflowRecoverySettledEvent } from './recovery-events.js'
import { sameWorkflowValue, workAssignmentAcceptedEvent } from './work-binding.js'
import { invalidHistory } from './errors.js'
import { hasPendingLowerExecution } from '../subagent/execution-evidence.js'

export interface WorkRecoveryState {
  readonly requested: CommittedSessionEvent<ReturnType<typeof workRecoveryRequestedEvent.decode>>
  settled: CommittedSessionEvent<ReturnType<typeof workRecoverySettledEvent.decode>> | null
  supersededBy: SessionEventId | null
}
export interface CoordinatorRecoveryState {
  readonly requested: CommittedSessionEvent<ReturnType<typeof workflowRecoveryRequestedEvent.decode>>
  settled: CommittedSessionEvent<ReturnType<typeof workflowRecoverySettledEvent.decode>> | null
  supersededBy: SessionEventId | null
}

/** Recovery ownership is exact per work acceptance or coordinator definition, including interrupted acknowledgements. */
export function projectWorkRecoveries(events: Iterable<CommittedSessionEvent>): WorkRecoveryState[] {
  const states: WorkRecoveryState[] = []
  for (const event of events) {
    if (event.stored.type === workRecoveryRequestedEvent.type) {
      const p = workRecoveryRequestedEvent.decode(event.payload)
      const prior = states.find(item => item.requested.payload.accepted === p.accepted && item.settled === null && item.supersededBy === null)
      if (p.through !== event.stored.sequence - 1 || (prior?.requested.stored.eventId ?? null) !== p.supersedes) invalidHistory('work-recovery-owner')
      if (prior !== undefined) prior.supersededBy = event.stored.eventId
      states.push({ requested: { ...event, payload: p }, settled: null, supersededBy: null })
    } else if (event.stored.type === workRecoverySettledEvent.type) {
      const p = workRecoverySettledEvent.decode(event.payload), owner = states.find(item => item.requested.stored.eventId === p.recovery)
      if (owner === undefined || owner.settled !== null || owner.supersededBy !== null
        || p.writes !== event.stored.sequence - owner.requested.payload.through || p.writes > owner.requested.payload.maxWrites) invalidHistory('work-recovery-settlement')
      owner.settled = { ...event, payload: p }
    }
  }
  return states
}

export function projectCoordinatorRecoveries(events: Iterable<CommittedSessionEvent>): CoordinatorRecoveryState[] {
  const states: CoordinatorRecoveryState[] = []
  for (const event of events) {
    if (event.stored.type === workflowRecoveryRequestedEvent.type) {
      const p = workflowRecoveryRequestedEvent.decode(event.payload), prior = states.find(item => item.settled === null && item.supersededBy === null)
      if (p.through !== event.stored.sequence - 1 || (prior?.requested.stored.eventId ?? null) !== p.supersedes) invalidHistory('coordinator-recovery-owner')
      if (prior !== undefined) prior.supersededBy = event.stored.eventId
      states.push({ requested: { ...event, payload: p }, settled: null, supersededBy: null })
    } else if (event.stored.type === workflowRecoverySettledEvent.type) {
      const p = workflowRecoverySettledEvent.decode(event.payload), owner = states.find(item => item.requested.stored.eventId === p.recovery)
      if (owner === undefined || owner.settled !== null || owner.supersededBy !== null
        || p.writes !== event.stored.sequence - owner.requested.payload.through || p.writes > owner.requested.payload.maxWrites) invalidHistory('coordinator-recovery-settlement')
      owner.settled = { ...event, payload: p }
    }
  }
  return states
}

export function applyWorkRecoveryEvent(state: AgentProjectionState, event: CommittedSessionEvent): void {
  if (event.stored.payloadVersion !== 1 || event.stored.ignorable) invalidHistory('work-recovery-version')
  const events = [...state.sources.values(), event]
  const recoveries = projectWorkRecoveries(events)
  if (state.openRun !== null || state.openRecovery !== null || hasPendingLowerExecution(state.sources.values())) invalidHistory('work-recovery-lower-open')
  const request = event.stored.type === workRecoveryRequestedEvent.type ? workRecoveryRequestedEvent.decode(event.payload)
    : recoveries.find(item => item.settled?.stored.eventId === event.stored.eventId)!.requested.payload
  const accepted = source(state, request.accepted, workAssignmentAcceptedEvent).payload
  if (!sameWorkflowValue(accepted.assignment, request.assignment)) invalidHistory('work-recovery-assignment')
}

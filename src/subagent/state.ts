import type { WorkspaceBaselineRecorded } from './workspace-events.js'
import type { SubagentProvisionSettled, SubagentDeliveryFailed, SubagentControlRequested, SubagentControlSettled, SubagentSettlementObserved, SubagentRecoveryRequested, SubagentRecoverySettled } from './lifecycle-contract.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
import type { DelegationIdentity } from './event-contract.js'
import { SubagentError } from './errors.js'
import { equal } from '../agent/validation.js'
import type { ChildBound, ChildReady, DelegationRequested, SubagentReleaseRecorded, SubagentResourceOpened, SubagentProtocolRecorded, SubagentMessageClassified } from './event-contract.js'

export type SubagentResourceState = {
  readonly opened: CommittedSessionEvent<SubagentResourceOpened>
  readonly released: CommittedSessionEvent<SubagentReleaseRecorded> | null
}
export type SubagentControlState = { readonly requested: CommittedSessionEvent<SubagentControlRequested>; readonly settled: CommittedSessionEvent<SubagentControlSettled> | null }
export type SubagentRecoveryState = { readonly requested: CommittedSessionEvent<SubagentRecoveryRequested>; readonly settled: CommittedSessionEvent<SubagentRecoverySettled> | null; readonly supersededBy: SessionEventId | null }
export type SubagentState = {
  readonly baselines: readonly CommittedSessionEvent<WorkspaceBaselineRecorded>[]
  readonly provisions: readonly CommittedSessionEvent<SubagentProvisionSettled>[]
  readonly failures: readonly CommittedSessionEvent<SubagentDeliveryFailed>[]
  readonly observations: readonly CommittedSessionEvent<SubagentSettlementObserved>[]
  readonly controls: readonly SubagentControlState[]
  readonly recoveries: readonly SubagentRecoveryState[]
  readonly protocol: readonly CommittedSessionEvent<SubagentProtocolRecorded>[]
  readonly classifications: readonly CommittedSessionEvent<SubagentMessageClassified>[]
  readonly delegations: readonly CommittedSessionEvent<DelegationRequested>[]
  readonly bound: CommittedSessionEvent<ChildBound> | null
  readonly ready: CommittedSessionEvent<ChildReady> | null
  readonly resources: readonly SubagentResourceState[]
}
/** Accumulators are local to one replay; callers receive immutable arrays of committed facts. */
export type SubagentProjectionState = {
  readonly baselines: Map<SessionEventId, CommittedSessionEvent<WorkspaceBaselineRecorded>>
  readonly provisions: Map<SessionEventId, CommittedSessionEvent<SubagentProvisionSettled>>
  readonly failures: Map<SessionEventId, CommittedSessionEvent<SubagentDeliveryFailed>>
  readonly observations: Map<SessionEventId, CommittedSessionEvent<SubagentSettlementObserved>>
  readonly controls: Map<SessionEventId, { requested: SubagentControlState['requested']; settled: SubagentControlState['settled'] }>
  readonly recoveries: Map<SessionEventId, { requested: SubagentRecoveryState['requested']; settled: SubagentRecoveryState['settled']; supersededBy: SessionEventId | null }>
  readonly protocol: Map<SessionEventId, CommittedSessionEvent<SubagentProtocolRecorded>>
  readonly classifications: Map<SessionEventId, CommittedSessionEvent<SubagentMessageClassified>>
  readonly delegations: Map<SessionEventId, CommittedSessionEvent<DelegationRequested>>
  bound: CommittedSessionEvent<ChildBound> | null
  ready: CommittedSessionEvent<ChildReady> | null
  readonly resources: Map<SessionEventId, { opened: SubagentResourceState['opened']; released: SubagentResourceState['released'] }>
}
export function initialSubagentState(): SubagentProjectionState {
  return { baselines: new Map(), provisions: new Map(), failures: new Map(), observations: new Map(), controls: new Map(), recoveries: new Map(), delegations: new Map(), bound: null, ready: null, resources: new Map(), protocol: new Map(), classifications: new Map() }
}

/** Resolve only an already visible public relationship; this never opens the peer Session. */
export function requireDelegationBinding(state: SubagentProjectionState, id: DelegationIdentity): DelegationRequested {
  const request = state.delegations.get(id.delegation)?.payload
    ?? (state.bound?.payload.delegation === id.delegation ? state.bound.payload.requested : undefined)
  if (request === undefined || !equal([request.parentAddress, request.childAddress], [id.parentAddress, id.childAddress])) {
    throw new SubagentError('SUBAGENT_STATE_INVALID', 'missing-delegation-binding')
  }
  return request
}

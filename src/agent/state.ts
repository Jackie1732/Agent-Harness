import type { MessageEnvelope } from '../communication/types.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { AgentActionReference, AgentBudget, AgentInput, AgentInputReference, AgentInputStatus, AgentRootOutcome, AgentSpec } from './contract.js'
import type { AgentActionSettled, AgentCommandAccepted, AgentControlRequest, AgentControlSettled, AgentMaintenanceRunSettled,
  AgentMaintenanceRunStarted, AgentRunSettled, AgentRunStarted,
  AgentStepDecided, AgentStepOpened, AgentTurnSettled, AgentTurnStarted, AgentWaitSettled } from './event-contract.js'

export type AgentInputState = {
  readonly reference: AgentInputReference
  readonly input: AgentInput | null
  readonly message: MessageEnvelope | null
  readonly acceptedAt: string
  readonly sequence: number
  readonly lane: string
  readonly status: AgentInputStatus
  readonly claimedBy: SessionEventId | null
  readonly reservedBy: AgentActionReference | null
  readonly everMatched: boolean
  readonly reason: string | null
}
export type AgentRootState = {
  readonly id: SessionEventId
  readonly deadline: string
  readonly budget: AgentBudget
  readonly outcome: AgentRootOutcome | null
  readonly reason: string | null
  readonly stopControl: SessionEventId | null
}
export type AgentRunState = {
  readonly started: CommittedSessionEvent<AgentRunStarted | AgentMaintenanceRunStarted>
  readonly settled: CommittedSessionEvent<AgentRunSettled | AgentMaintenanceRunSettled> | null
}
export type AgentTurnState = { readonly started: CommittedSessionEvent<AgentTurnStarted>; readonly root: SessionEventId; readonly settled: CommittedSessionEvent<AgentTurnSettled> | null }
export type AgentStepState = { readonly opened: CommittedSessionEvent<AgentStepOpened>; readonly decided: CommittedSessionEvent<AgentStepDecided> | null }
export type AgentWaitState = {
  readonly reference: AgentActionReference
  readonly created: CommittedSessionEvent<AgentActionSettled>
  readonly turn: SessionEventId
  readonly settled: CommittedSessionEvent<AgentWaitSettled> | null
}
export type AgentControlState = {
  readonly requested: CommittedSessionEvent<AgentControlRequest>
  readonly settled: CommittedSessionEvent<AgentControlSettled> | null
  readonly supersededBy: SessionEventId | null
}
export type AgentSessionSnapshot = {
  readonly spec: CommittedSessionEvent<AgentSpec> | null
  readonly runs: readonly AgentRunState[]
  readonly turns: readonly AgentTurnState[]
  readonly steps: readonly AgentStepState[]
  readonly actions: readonly CommittedSessionEvent<AgentActionSettled>[]
  readonly waits: readonly AgentWaitState[]
  readonly controls: readonly AgentControlState[]
  readonly commands: readonly CommittedSessionEvent<AgentCommandAccepted>[]
  readonly inputs: readonly AgentInputState[]
  readonly roots: readonly AgentRootState[]
  readonly laneOrdinals: readonly { readonly lane: string; readonly ordinal: number }[]
  readonly openRun: SessionEventId | null
  readonly openTurn: SessionEventId | null
  readonly openRecovery: SessionEventId | null
  readonly closing: SessionEventId | null
}

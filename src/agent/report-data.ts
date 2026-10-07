import type { AgentActionReference, AgentInputReference, AgentInputStatus, AgentRootOutcome, AgentRunSelection, AgentBudget, AgentWaitDescriptor, AgentTurnOutcome, AgentNativeActionName, WorkflowNativeActionName } from './contract.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { AgentRunStarted, AgentRunSettled, AgentMaintenanceRunStarted, AgentMaintenanceRunSettled, AgentActionSettled, AgentWaitSettled, AgentControlRequest } from './event-contract.js'

/** Persisted run records and bounded operator facts, without a runtime owner. */
export interface AgentRunReport {
  readonly run: { readonly started: CommittedSessionEvent<AgentRunStarted | AgentMaintenanceRunStarted>; readonly settled: CommittedSessionEvent<AgentRunSettled | AgentMaintenanceRunSettled> | null } | null
  readonly openRun: SessionEventId | null
  readonly openTurn: SessionEventId | null
  readonly roots: readonly { readonly id: SessionEventId; readonly deadline: string; readonly budget: AgentBudget; readonly limit: AgentBudget; readonly allowedTools: readonly string[]; readonly allowedNativeActions: readonly (AgentNativeActionName | WorkflowNativeActionName)[]; readonly source: AgentRunSelection; readonly outcome: AgentRootOutcome | null; readonly reason: string | null; readonly stopControl: SessionEventId | null }[]
  readonly inputs: readonly { readonly reference: AgentInputReference; readonly lane: string; readonly status: AgentInputStatus; readonly claimedBy: SessionEventId | null; readonly reservedBy: AgentActionReference | null; readonly everMatched: boolean; readonly reason: string | null }[]
  readonly waits: readonly { readonly reference: AgentActionReference; readonly created: CommittedSessionEvent<AgentActionSettled>; readonly turn: SessionEventId; readonly settled: CommittedSessionEvent<AgentWaitSettled> | null }[]
  readonly modelUsage: readonly { readonly step: SessionEventId; readonly settled: SessionEventId; readonly external: 'not-issued' | 'may-have-been-issued' | 'response-observed'; readonly usage: { readonly source: 'provider'; readonly completeness: 'unknown' | 'partial' | 'complete'; readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadInputTokens?: number; readonly cacheCreationInputTokens?: number; readonly reasoningOutputTokens?: number } }[]
  readonly pendingReceipts: readonly { readonly reference: AgentInputReference; readonly disposition: AgentInputStatus }[]
  readonly pendingControls: readonly { readonly eventId: SessionEventId; readonly kind: AgentControlRequest['kind'] }[]
  readonly pendingOutbox: readonly { readonly messageId: import('../communication/ids.js').MessageId; readonly accepted: SessionEventId; readonly attemptCount: number }[]
  readonly turns: readonly { readonly turn: SessionEventId; readonly root: SessionEventId; readonly settled: SessionEventId | null; readonly outcome: AgentTurnOutcome | null }[]
  readonly truncated: { readonly roots: boolean; readonly inputs: boolean; readonly waits: boolean; readonly modelUsage: boolean; readonly pendingReceipts: boolean; readonly pendingControls: boolean; readonly pendingOutbox: boolean; readonly turns: boolean }
  readonly counts: { roots: number; inputs: number; pendingWaits: number; modelUsage: number; pendingReceipts: number; pendingControls: number; pendingOutbox: number; turns: number; pendingInputs: number; queuedInputs: number; reservedInputs: number; reviewRequiredInputs: number; failedRoots: number; exhaustedRoots: number }
  readonly nextWakeAt: string | null
  readonly final: { readonly turn: SessionEventId; readonly settled: SessionEventId; readonly text: string | null; readonly textBytes: number; readonly textOmitted: boolean } | null
}

/** Receipt for the exact direct command, independent of report truncation. */
export interface AgentCommandReceipt {
  readonly status: 'outbox-accepted' | 'not-accepted'
  readonly runId: SessionEventId
  readonly commandEventId: SessionEventId | null
  readonly action: AgentActionReference | null
  readonly outboxAcceptedEventId: SessionEventId | null
  readonly messageId: import('../communication/ids.js').MessageId | null
  readonly reason: string | null
}

export interface AgentCommandReport extends AgentRunReport { readonly command: AgentCommandReceipt; readonly cuts: readonly import('../session/types.js').SessionProjectionCoverage[] }

/** Exact model source of one completed Root's final Turn. */
export interface AgentRootFinal {
  readonly turnId: SessionEventId
  readonly stepId: SessionEventId
  readonly modelSettledId: SessionEventId
  readonly text: string | null
  readonly textBytes: number
  readonly textOmitted: boolean
}

export interface AgentRootWait { readonly reference: AgentActionReference; readonly descriptor: AgentWaitDescriptor }

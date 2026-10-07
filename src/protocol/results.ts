import type { JsonValue } from '../foundation/json.js'
import type { SessionAddress, SessionEventId, SessionId } from '../session/ids.js'
import type { SessionProjectionCoverage, StoredSessionEvent } from '../session/types.js'
import type { AgentActionReference, AgentInputStatus, AgentRootOutcome, AgentRunSelection, AgentWaitDescriptor } from '../agent/contract.js'
import type { AgentRunReport } from '../agent/report-data.js'
import type { AgentReadiness } from '../agent/readiness-data.js'
import type { HostRunReport, HostCurrentReport } from '../host/report-data.js'
import type { WorkflowReport } from '../host/workflow-report-data.js'
import type { DelegationReportEntry } from '../subagent/report-data.js'
import type { InboxMessageFact, OutboxMessageSnapshot } from '../communication/types.js'
import type { MessageId } from '../communication/ids.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import type { InputSubmission, SessionEventCursor } from './references.js'

/** Observation cuts describe the exact immutable inputs used to produce this data. */
export interface ObservationEvidence {
  readonly instanceId: string
  readonly cuts: readonly SessionProjectionCoverage[]
  readonly recoveryRequired: boolean
}
export interface ReceiptEvidence { readonly instanceId: string; readonly cuts: readonly SessionProjectionCoverage[] }
export interface HostStatusResult extends ReceiptEvidence {
  readonly hostStatus: 'ready' | 'stopping' | 'stopped' | 'failed'
  readonly activity: 'idle' | 'run' | 'command'
  readonly report: HostCurrentReport
}
export interface HostRunResult extends ReceiptEvidence { readonly report: HostRunReport }
export interface ShutdownResult {
  readonly instanceId: string; readonly mode: 'drain' | 'cancel'; readonly hostStatus: 'stopped'; readonly serviceStatus: 'closing'
}
export interface AgentObservation extends ObservationEvidence {
  readonly agentKey: string; readonly sessionId: SessionId; readonly paused: boolean; readonly faulted: boolean
  readonly mailbox: 'online' | 'known-offline' | 'ended'; readonly routingPaused: boolean
  readonly readiness: AgentReadiness; readonly report: AgentRunReport
}
export interface AgentPauseResult { readonly agentKey: string; readonly instanceId: string; readonly paused: true }
export interface AgentResumeResult {
  readonly agentKey: string; readonly instanceId: string; readonly paused: boolean
  readonly resumptions: readonly { readonly delegationId: SessionEventId; readonly status: 'resumed' | 'blocked'; readonly reasonCode: string }[]
}
export interface InputReceipt { readonly agentKey: string; readonly sessionId: SessionId; readonly inputEventId: SessionEventId; readonly reused: boolean }
export interface InputObservation extends ObservationEvidence {
  readonly agentKey: string; readonly sessionId: SessionId; readonly inputEventId: SessionEventId; readonly kind: 'task' | 'answer'
  readonly submission: InputSubmission | null; readonly status: AgentInputStatus; readonly claimedBy: SessionEventId | null
  readonly rootId: SessionEventId | null; readonly reason: string | null; readonly wait: AgentActionReference | null
}
export interface RootFinal {
  readonly turnId: SessionEventId; readonly stepId: SessionEventId; readonly modelSettledId: SessionEventId
  readonly text: string | null; readonly textBytes: number; readonly textOmitted: boolean
}
export interface RootObservation extends ObservationEvidence {
  readonly agentKey: string; readonly sessionId: SessionId; readonly rootId: SessionEventId; readonly source: AgentRunSelection
  readonly outcome: AgentRootOutcome | null; readonly reason: string | null; readonly stopControl: SessionEventId | null
  readonly waits: readonly { readonly reference: AgentActionReference; readonly descriptor: AgentWaitDescriptor }[]
  readonly final: RootFinal | null; readonly executionPending: boolean
}
export interface RootCancelResult extends ObservationEvidence {
  readonly agentKey: string; readonly sessionId: SessionId; readonly rootId: SessionEventId
  readonly stopControl: SessionEventId | null; readonly outcome: AgentRootOutcome | null
}
interface MessageCommandBase extends ReceiptEvidence { readonly agentKey: string; readonly sessionId: SessionId }
export type MessageCommandResult = MessageCommandBase & (
  | { readonly status: 'outbox-accepted'; readonly runId: SessionEventId; readonly commandEventId: SessionEventId
    readonly action: AgentActionReference; readonly outboxAcceptedEventId: SessionEventId; readonly messageId: MessageId; readonly reason: null }
  | { readonly status: 'not-accepted'; readonly runId: SessionEventId | null; readonly commandEventId: SessionEventId | null
    readonly action: AgentActionReference | null; readonly outboxAcceptedEventId: null; readonly messageId: null; readonly reason: string }
)
interface MessageObservationBase extends ObservationEvidence { readonly agentKey: string; readonly sessionId: SessionId }
export type MessageObservation = MessageObservationBase & (
  | { readonly direction: 'outbox'; readonly fact: OutboxMessageSnapshot }
  | { readonly direction: 'inbox'; readonly fact: InboxMessageFact }
)
export interface DelegationReceipt extends ReceiptEvidence {
  readonly delegationId: SessionEventId; readonly childSessionId: SessionId; readonly childAddress: SessionAddress
}
export type DelegationCancelResult = ReceiptEvidence & (
  | { readonly status: 'requested'; readonly eventId: SessionEventId }
  | { readonly status: 'already-closed' }
)
export type DelegationObservation = DelegationReportEntry & ObservationEvidence
export type WorkflowObservation = WorkflowReport & ObservationEvidence
export type WorkflowControlStatus = 'applied' | 'resumed' | 'no-op'
export interface WorkflowControlResult<S extends WorkflowControlStatus = WorkflowControlStatus> extends ReceiptEvidence { readonly status: S; readonly ref: WorkflowEventRef }
export interface WaitResult<T> { readonly status: 'condition-met' | 'timeout' | 'host-closed'; readonly observation: T }
interface WorkflowOutputBase extends ReceiptEvidence { readonly workflowKey: string; readonly nodeKey: string }
export type WorkflowOutputResult = WorkflowOutputBase & (
  | { readonly status: 'available'; readonly value: JsonValue; readonly decisionRef: WorkflowEventRef; readonly assignmentRef: WorkflowEventRef; readonly proposalRef: WorkflowEventRef }
  | { readonly status: 'not-available' }
)
export interface WorkflowArtifactResult extends ReceiptEvidence {
  readonly workflowKey: string; readonly artifactRef: WorkflowEventRef; readonly decisionRef: WorkflowEventRef
  readonly assignmentRef: WorkflowEventRef; readonly proposalRef: WorkflowEventRef; readonly mediaType: 'text/plain'
  readonly text: string; readonly byteLength: number; readonly sha256: string
}
export interface SessionEventPage {
  readonly sessionId: SessionId; readonly through: number; readonly parent: SessionProjectionCoverage | null
  readonly events: readonly StoredSessionEvent[]; readonly nextCursor: SessionEventCursor | null; readonly hasMore: boolean
}

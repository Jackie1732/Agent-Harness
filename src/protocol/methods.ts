import type { SessionEventId } from '../session/ids.js'
import type { MessageId } from '../communication/ids.js'
import type { AgentActionReference } from '../agent/contract.js'
import type { DelegationRequest } from '../subagent/contract.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import type { SessionTarget, SessionEventCursor } from './references.js'
import type * as R from './results.js'

type Method<P, T> = { readonly params: P; readonly result: T }
type AgentTarget = { readonly agentKey: string }
type RootTarget = AgentTarget & { readonly rootId: SessionEventId }
type DelegationTarget = { readonly parentAgentKey: string; readonly parentRoot: SessionEventId; readonly delegationId: SessionEventId }
type WorkflowTarget = { readonly workflowKey: string }
type WorkflowControl = WorkflowTarget & { readonly requestKey: string; readonly reason: string }
type MessageContent = { readonly type: string; readonly payloadVersion: number; readonly payloadJson: string }

/** The closed v1 method map is shared by dispatch, authorization and the generic client. */
export interface MethodMap {
  readonly 'host.status': Method<Record<string, never>, R.HostStatusResult>
  readonly 'host.run': Method<{ readonly expectedInstanceId: string }, R.HostRunResult>
  readonly 'host.shutdown': Method<{ readonly expectedInstanceId: string; readonly mode: 'drain' | 'cancel' }, R.ShutdownResult>
  readonly 'agent.get': Method<AgentTarget, R.AgentObservation>
  readonly 'agent.pause': Method<AgentTarget & { readonly expectedInstanceId: string }, R.AgentPauseResult>
  readonly 'agent.resume': Method<AgentTarget & { readonly expectedInstanceId: string }, R.AgentResumeResult>
  readonly 'input.submit': Method<AgentTarget & { readonly submissionKey: string; readonly text: string }, R.InputReceipt>
  readonly 'input.answer': Method<AgentTarget & { readonly submissionKey: string; readonly wait: AgentActionReference; readonly text: string }, R.InputReceipt>
  readonly 'input.get': Method<AgentTarget & ({ readonly inputEventId: SessionEventId; readonly submissionKey?: never } | { readonly submissionKey: string; readonly inputEventId?: never }), R.InputObservation>
  readonly 'root.get': Method<RootTarget, R.RootObservation>
  readonly 'root.wait': Method<RootTarget & { readonly timeoutMs: number }, R.WaitResult<R.RootObservation>>
  readonly 'root.cancel': Method<RootTarget & { readonly reason: string }, R.RootCancelResult>
  readonly 'message.send': Method<AgentTarget & MessageContent & { readonly peerKey: string }, R.MessageCommandResult>
  readonly 'message.reply': Method<AgentTarget & MessageContent & { readonly messageId: MessageId }, R.MessageCommandResult>
  readonly 'message.get': Method<AgentTarget & { readonly messageId: MessageId; readonly direction: 'outbox' | 'inbox' }, R.MessageObservation>
  readonly 'message.wait': Method<AgentTarget & { readonly messageId: MessageId; readonly timeoutMs: number } & (
    { readonly direction: 'outbox'; readonly until: 'terminal' } | { readonly direction: 'inbox'; readonly until: 'disposed' }), R.WaitResult<R.MessageObservation>>
  readonly 'session.events': Method<{ readonly target: SessionTarget; readonly maxEvents: number } & (
    { readonly after?: number; readonly cursor?: never } | { readonly cursor: SessionEventCursor; readonly after?: never }), R.SessionEventPage>
  readonly 'delegation.spawn': Method<{ readonly parentAgentKey: string; readonly parentRoot: SessionEventId; readonly requestKey: string; readonly request: DelegationRequest }, R.DelegationReceipt>
  readonly 'delegation.get': Method<DelegationTarget, R.DelegationObservation>
  readonly 'delegation.wait': Method<DelegationTarget & { readonly until: 'business' | 'closed'; readonly timeoutMs: number }, R.WaitResult<R.DelegationObservation>>
  readonly 'delegation.cancel': Method<DelegationTarget & { readonly requestKey: string }, R.DelegationCancelResult>
  readonly 'workflow.get': Method<WorkflowTarget, R.WorkflowObservation>
  readonly 'workflow.wait': Method<WorkflowTarget & { readonly until: 'settled' | 'closed'; readonly timeoutMs: number }, R.WaitResult<R.WorkflowObservation>>
  readonly 'workflow.pause': Method<WorkflowControl, R.WorkflowControlResult<'applied' | 'no-op'>>
  readonly 'workflow.resume': Method<WorkflowControl, R.WorkflowControlResult>
  readonly 'workflow.cancel': Method<WorkflowControl, R.WorkflowControlResult<'applied' | 'no-op'>>
  readonly 'workflow.retry': Method<WorkflowTarget & { readonly requestKey: string; readonly nodeKey: string; readonly failedAssignment: WorkflowEventRef }, R.WorkflowControlResult<'applied' | 'no-op'>>
  readonly 'workflow.output': Method<WorkflowTarget & { readonly nodeKey: string }, R.WorkflowOutputResult>
  readonly 'workflow.artifact': Method<WorkflowTarget & { readonly artifactRef: WorkflowEventRef }, R.WorkflowArtifactResult>
}
export type Params<M extends keyof MethodMap> = MethodMap[M]['params']
export type Result<M extends keyof MethodMap> = MethodMap[M]['result']

import type { ModelIntentReference } from '../model/contract.js'
import type { SessionEventId, SessionLogPosition } from '../session/ids.js'
import type { ModelInvocationId } from '../model/ids.js'
import type { AgentActionReference, AgentBudget, AgentInput, AgentInputDisposition, AgentInputReference, AgentRootOutcome,
  AgentRunStop, AgentSendCommand, AgentSpec, AgentTurnOutcome, AgentWaitDescriptor } from './contract.js'

export type AgentInputAccepted = { readonly spec: SessionEventId; readonly input: AgentInput }
export type AgentRunStarted = { readonly spec: SessionEventId; readonly kind: 'drive' | 'command' }
export type AgentRunSettled = { readonly run: SessionEventId; readonly stoppedBy: AgentRunStop; readonly reason: string }
export type AgentMaintenanceRunStarted = { readonly spec: SessionEventId; readonly kind: 'maintenance' }
export type AgentMaintenanceRunSettled = {
  readonly run: SessionEventId
  readonly stoppedBy: 'idle' | 'run-budget' | 'cancelled' | 'faulted' | 'interrupted'
  readonly reason: string
}
export type AgentTurnStarted = {
  readonly run: SessionEventId
  readonly input: AgentInputReference
  readonly lane: string
  readonly ordinal: number
  readonly root: SessionEventId | null
  readonly predecessor: AgentActionReference | null
  readonly deadline: string | null
  readonly observedAt: string
}
export type AgentStepOpened = { readonly turn: SessionEventId; readonly ordinal: number; readonly outputTokens: number; readonly observedAt: string }
export type AgentActionIntent = {
  readonly source: ModelIntentReference
  readonly route: 'tool' | 'send' | 'reply' | 'wait' | 'ask' | 'invalid'
}
export type AgentStepDecided = {
  readonly step: SessionEventId
  readonly model: { readonly invocationId: ModelInvocationId; readonly assembly: SessionEventId; readonly settled: SessionEventId } | null
  readonly classification: 'final' | 'actions' | 'failed' | 'cancelled' | 'not-issued'
  readonly reason: string
  readonly actions: readonly AgentActionIntent[]
  readonly admitted: boolean
  readonly reservation: AgentBudget
  readonly reassemblies: number
  readonly observedAt: string
}
export type AgentActionResult =
  | { readonly kind: 'tool'; readonly settled: SessionEventId }
  | { readonly kind: 'outbox'; readonly accepted: SessionEventId }
  | { readonly kind: 'wait'; readonly descriptor: AgentWaitDescriptor }
  | { readonly kind: 'not-started'; readonly reason: string }
  | { readonly kind: 'communication-not-accepted'; readonly reason: string; readonly basis: 'observed-rejection' | 'recovered-absence' }
export type AgentActionSettled = { readonly action: AgentActionReference; readonly result: AgentActionResult }
export type AgentTurnSettled = {
  readonly turn: SessionEventId
  readonly outcome: AgentTurnOutcome
  readonly rootOutcome: AgentRootOutcome | null
  readonly reason: string
  readonly disposition: AgentInputDisposition
  readonly finalStep: SessionEventId | null
  readonly budget: AgentBudget
}
export type AgentWaitSettled = {
  readonly wait: AgentActionReference
  readonly outcome: 'matched' | 'timed-out' | 'cancelled' | 'unavailable'
  readonly response: AgentInputReference | null
  readonly reason: string
  readonly observedAt: string
  readonly supportedMessages: readonly { readonly type: string; readonly payloadVersion: number }[]
  readonly outboxTerminal: SessionEventId | null
}
export type AgentCommandAccepted = { readonly run: SessionEventId; readonly spec: SessionEventId; readonly root: null; readonly command: AgentSendCommand }
export type AgentControlRequest =
  | { readonly kind: 'cancel-work'; readonly root: SessionEventId; readonly reason: string }
  | { readonly kind: 'expire-work'; readonly root: SessionEventId; readonly reason: string; readonly deadline: string; readonly observedAt: string }
  | { readonly kind: 'abandon-input'; readonly input: AgentInputReference; readonly reason: string }
  | { readonly kind: 'close-session'; readonly reason: string }
  | { readonly kind: 'recovery'; readonly targetRun: SessionEventId | null; readonly controls: readonly SessionEventId[];
    readonly through: SessionLogPosition; readonly predecessorStopped: true; readonly supersedes: SessionEventId | null; readonly maxRecoveryWrites: number }
export type AgentControlSettled = {
  readonly control: SessionEventId
  readonly outcome: 'completed' | 'rejected' | 'no-op' | 'recovered' | 'recovery-incomplete'
  readonly reason: string
  readonly rootOutcome: AgentRootOutcome | null
  readonly responseDisposition: 'release-peer' | 'not-adopted' | null
}

export type AgentEventPayloads = {
  readonly 'spec-recorded': AgentSpec
  readonly 'input-accepted': AgentInputAccepted
  readonly 'run-started': AgentRunStarted
  readonly 'run-settled': AgentRunSettled
  readonly 'turn-started': AgentTurnStarted
  readonly 'step-opened': AgentStepOpened
  readonly 'step-decided': AgentStepDecided
  readonly 'action-settled': AgentActionSettled
  readonly 'turn-settled': AgentTurnSettled
  readonly 'wait-settled': AgentWaitSettled
  readonly 'command-accepted': AgentCommandAccepted
  readonly 'control-requested': AgentControlRequest
  readonly 'control-settled': AgentControlSettled
}

import type { ContextMemoryQuery, ContextModelTarget, ContextUnitReference } from '../context/contract.js'
import type { ChannelId, MessageId } from '../communication/ids.js'
import type { SessionAddress, SessionEventId } from '../session/ids.js'
import type { AgentSubagentRole } from '../subagent/contract.js'

export const agentNativeActionNames = ['agent_send_message', 'agent_reply_message', 'agent_await_reply', 'agent_ask_user'] as const
export const subagentNativeActionNames = ['agent_spawn_subagent', 'agent_await_subagent', 'agent_answer_subagent', 'agent_ask_parent', 'agent_report_progress'] as const
export const workflowNativeActionNames = ['agent_ask_work_peer', 'agent_await_work_message', 'agent_answer_work_peer',
  'agent_report_work_progress', 'agent_send_work_group'] as const
export type AgentNativeActionName = typeof agentNativeActionNames[number] | typeof subagentNativeActionNames[number]
export type WorkflowNativeActionName = typeof workflowNativeActionNames[number] | 'agent_ask_user' | 'agent_spawn_subagent'
export type AgentActionReference = { readonly eventId: SessionEventId; readonly index: number }
export type AgentInputReference = { readonly kind: 'user' | 'peer' | 'subagent' | 'workflow'; readonly eventId: SessionEventId }
export type AgentInput =
  | { readonly kind: 'task'; readonly text: string; readonly originLabel: string }
  | { readonly kind: 'answer'; readonly wait: AgentActionReference; readonly text: string; readonly originLabel: string }
export type AgentBudget = {
  readonly models: number
  readonly steps: number
  readonly tools: number
  readonly messages: number
  readonly waits: number
  readonly outputTokens: number
}
export type AgentLimits = {
  readonly maxTurnsPerRun: number
  readonly maxManagementPerRun: number
  readonly maxDispatchRunsPerRun: number
  readonly maxJournalConflicts: number
  readonly maxReassemblies: number
  readonly maxPendingInputs: number
  readonly maxPendingWaits: number
  readonly maxLanes: number
  readonly maxInputBytes: number
  readonly maxActionsPerStep: number
  readonly maxActionBytes: number
  readonly maxResultBytes: number
  readonly maxReportEntries: number
  readonly maxWaitMs: number
}

/** Immutable choices only; providers, policies, clocks and handles belong to assembly. */
export type AgentSpecV1 = {
  readonly protocolVersion: 1
  readonly label: string
  readonly responsibility: string
  readonly nonGoals: readonly string[]
  readonly profileEventId: SessionEventId
  readonly target: ContextModelTarget
  readonly toolNames: readonly string[]
  readonly nativeActions: readonly (typeof agentNativeActionNames[number])[]
  readonly peers: readonly { readonly key: string; readonly address: SessionAddress; readonly channelId: ChannelId }[]
  readonly messages: readonly { readonly type: string; readonly payloadVersion: number; readonly requiresReply: boolean }[]
  readonly context: {
    readonly history: { readonly mode: 'none' | 'completed-roots'; readonly maxRoots: number }
    readonly memory: { readonly required: readonly ContextUnitReference[]; readonly query: ContextMemoryQuery }
    readonly compactions: readonly SessionEventId[]
  }
  readonly budget: AgentBudget
  readonly rootDurationMs: number
  readonly maxDirectSendCommandsPerSession: number
  readonly limits: AgentLimits
  readonly errorFeedback: 'new-step' | 'stop'
  readonly usagePolicy: 'observe-only' | 'stop-on-unknown'
  readonly businessRefusalHandled: boolean
}

/** Version 2 adds explicit delegation authority without changing a recorded v1 Spec. */
export type AgentSpecV2 = Omit<AgentSpecV1, 'protocolVersion' | 'nativeActions'> & {
  readonly protocolVersion: 2
  readonly nativeActions: readonly AgentNativeActionName[]
  readonly subagents: AgentSubagentRole
}
export type AgentWorkflowRole = { readonly kind: 'disabled' } | {
  readonly kind: 'participant'
  readonly toolNames: readonly string[]
  readonly nativeActions: readonly WorkflowNativeActionName[]
  readonly resourceIds: readonly string[]
}
/** Version 3 records separate authority for ordinary and Workflow roots. */
export type AgentSpecV3 = Omit<AgentSpecV2, 'protocolVersion'> & {
  readonly protocolVersion: 3
  readonly workflow: AgentWorkflowRole
}
export type AgentSpec = AgentSpecV1 | AgentSpecV2 | AgentSpecV3
export type ChildAgentSpecTemplate = Omit<AgentSpecV2, 'profileEventId' | 'subagents'>

export type AgentRunSelection = { readonly kind: 'ordinary' } | { readonly kind: 'workflow'; readonly assignment: import('../workflow/types.js').WorkflowEventRef }

export type AgentTurnOutcome = 'completed' | 'waiting' | 'failed' | 'cancelled' | 'budget-exhausted' | 'result-unknown' | 'interrupted'
export type AgentRootOutcome = 'completed' | 'failed' | 'cancelled' | 'budget-exhausted' | 'result-unknown' | 'timed-out'
export type AgentInputDisposition = 'handled' | 'review-required' | 'abandoned' | 'not-adopted'
export type AgentInputStatus = 'queued' | 'reserved' | 'claimed' | AgentInputDisposition
export type AgentRunStop = 'idle' | 'paused' | 'waiting' | 'run-budget' | 'cancelled' | 'faulted' | 'interrupted' | 'command-settled' | 'command-budget'
export type AgentWaitDescriptor = {
  readonly root: SessionEventId
  readonly deadline: string
  readonly observedAt: string
  readonly protectedTurns: readonly SessionEventId[]
} & (
  | { readonly kind: 'user'; readonly question: string }
  | { readonly kind: 'reply'; readonly messageId: MessageId; readonly outboxEventId: SessionEventId }
  | { readonly kind: 'delegation'; readonly delegation: SessionEventId }
  | { readonly kind: 'parent-answer'; readonly delegation: SessionEventId; readonly question: SessionEventId }
)

/** Commands are owned by a distinct Run and never mutate a root's obligations. */
export type AgentSendCommand =
  | { readonly kind: 'send'; readonly peerKey: string; readonly type: string; readonly payloadVersion: number; readonly payloadJson: string }
  | { readonly kind: 'reply'; readonly messageId: MessageId; readonly type: string; readonly payloadVersion: number; readonly payloadJson: string }

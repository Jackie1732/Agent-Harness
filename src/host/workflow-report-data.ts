import type { AgentBudget, AgentRootOutcome } from '../agent/contract.js'
import type { SessionEventId } from '../session/ids.js'
import type { WorkflowEventRef } from '../workflow/types.js'

export interface WorkExecutionReport {
  readonly assignment: WorkflowEventRef
  readonly root: SessionEventId
  readonly outcome: AgentRootOutcome | null
  readonly allowance: AgentBudget
  readonly reserved: AgentBudget
  readonly localReserved: AgentBudget
  readonly delegatedBudget: AgentBudget
  readonly execution: 'released' | 'unknown' | 'active' | 'release-pending'
  readonly recovery: SessionEventId | null
  readonly pendingWaits: number
  readonly externalWaits: number
  readonly exhausted: boolean
  readonly unknown: boolean
  readonly usage: { readonly modelCalls: number; readonly toolCalls: number; readonly unknownCalls: number; readonly inputTokens: number | null; readonly outputTokens: number | null }
  readonly groups: readonly { readonly request: SessionEventId; readonly interaction: WorkflowEventRef; readonly observedAt: string; readonly outcome: string; readonly recipients: readonly { readonly assignment: WorkflowEventRef; readonly status: string; readonly source: SessionEventId }[] }[]
}

export interface WorkflowReport {
  readonly workflowKey: string
  readonly desired: 'paused' | 'running'
  readonly state: string
  readonly settled: boolean
  readonly closed: boolean
  readonly terminal: WorkflowEventRef | null
  readonly budget: AgentBudget
  readonly reservedBudget: AgentBudget
  readonly usage: { readonly scope: 'participant-roots'; readonly modelCalls: number; readonly toolCalls: number; readonly unknownCalls: number; readonly inputTokens: number | null; readonly outputTokens: number | null }
  readonly recovery: readonly { readonly domain: string; readonly supersedes: SessionEventId }[]
  readonly work: readonly WorkExecutionReport[]
  readonly artifacts: readonly { readonly ref: WorkflowEventRef; readonly name: string; readonly mediaType: 'text/plain'; readonly byteLength: number; readonly sha256: string }[]
  readonly counts: { readonly workRoots: number; readonly artifacts: number; readonly unknown: number; readonly exhausted: number; readonly pendingResources: number; readonly cleanupIncomplete: number; readonly pendingRecoveries: number; readonly pendingWaits: number; readonly externalWaits: number; readonly runnable: number; readonly nodes: number; readonly assignments: number; readonly proposals: number; readonly reviews: number; readonly progress: number; readonly accepted: number; readonly failed: number; readonly pendingInbox: number; readonly questions: number; readonly pendingQuestions: number; readonly groups: number; readonly pendingGroups: number; readonly pendingControls: number; readonly retries: number; readonly pendingRetries: number; readonly pendingStops: number; readonly pendingOutbox: number }
  readonly progress: readonly { readonly inbox: SessionEventId; readonly value: { readonly assignment: WorkflowEventRef; readonly root: SessionEventId; readonly ordinal: number; readonly text: string } }[]
  readonly retries: readonly { readonly assignment: WorkflowEventRef; readonly failure: SessionEventId; readonly deadline: string; readonly request: SessionEventId | null; readonly consumed: SessionEventId | null; readonly expired: SessionEventId | null }[]
  readonly nodes: readonly { readonly nodeKey: string; readonly status: string }[]
  readonly assignments: readonly { readonly ref: WorkflowEventRef; readonly nodeKey: string; readonly memberKey: string; readonly attempt: number }[]
  readonly truncated: boolean
}

export interface WorkflowReportSummary {
  readonly count: number
  readonly failed: number
  readonly unknown: number
  readonly blocked: number
  readonly unclosed: number
  readonly runnable: number
  readonly exhausted: number
  readonly reports: readonly WorkflowReport[]
  readonly truncated: boolean
}

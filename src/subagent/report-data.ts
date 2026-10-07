import type { AgentBudget } from '../agent/contract.js'
import type { SessionEventId, SessionId } from '../session/ids.js'

/** Parent-side persisted facts plus the current installed resource owner flags. */
export interface DelegationReportEntry {
  readonly delegationId: SessionEventId
  readonly parentKey: string
  readonly parentRoot: SessionEventId
  readonly childSessionId: SessionId
  readonly deadline: string
  readonly grant: AgentBudget
  readonly localReserved: AgentBudget
  readonly parentProtocolReserve: AgentBudget
  readonly childModelUsage: { readonly settled: number; readonly partialOrUnknown: number; readonly inputTokens: number | null; readonly outputTokens: number | null } | null
  readonly parentResourceGenerations: number
  readonly businessResolved: boolean
  readonly executionReleased: boolean
  readonly adopted: boolean
  readonly inputDisposed: boolean
  readonly closed: boolean
  readonly resultAvailable: boolean
  readonly pendingQuestions: number
  readonly parentResources: readonly { readonly component: 'execution' | 'protocol'; readonly generation: number; readonly outcome: string }[]
  readonly childResources: readonly { readonly opened: SessionEventId; readonly component: 'execution' | 'protocol'; readonly generation: number; readonly release: SessionEventId | null; readonly outcome: 'pending' | 'released' | 'cleanup-incomplete' | 'unknown' }[]
  readonly cleanupIncomplete: boolean
  readonly suspended: boolean
  readonly recoveryRequired: boolean
  readonly failed: boolean
  readonly failureCode?: string | null
}

/** Whole-domain counts precede the bounded delegation display. */
export interface DelegationReport {
  readonly count: number
  readonly unresolved: number
  readonly blocked: number
  readonly failed: number
  readonly active: number
  readonly nextDeadline: string | null
  readonly delegations: readonly DelegationReportEntry[]
  readonly truncated: boolean
}

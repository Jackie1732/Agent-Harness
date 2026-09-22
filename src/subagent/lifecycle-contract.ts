import type { AgentRootOutcome } from '../agent/contract.js'
import type { SessionEventId, SessionLogPosition } from '../session/ids.js'
import type { DelegationIdentity } from './event-contract.js'

export type SubagentProvisionSettled = DelegationIdentity & {
  readonly outcome: 'installed' | 'failed' | 'reconciliation-required'
  readonly child: null | { readonly bound: SessionEventId; readonly profile: SessionEventId; readonly spec: SessionEventId;
    readonly ready: SessionEventId; readonly execution: SessionEventId; readonly protocol: SessionEventId }
  readonly phase: 'session' | 'installation' | 'protocol' | 'execution' | 'published'
  readonly cleanup: 'not-needed' | 'released' | 'cleanup-incomplete' | 'unknown'
  readonly reasonCode: string
}
export type SubagentDeliveryFailed = DelegationIdentity & {
  readonly protocol: SessionEventId
  readonly failure: 'outbox-terminal' | 'cancelled-before-send'
  readonly terminal: SessionEventId | null
  readonly reasonCode: string
}
export type SubagentControlRequested = DelegationIdentity & {
  readonly kind: 'cancel' | 'revoke'
  readonly source: { readonly kind: 'parent-stop'; readonly eventId: SessionEventId } | { readonly kind: 'controller'; readonly requestKey: string }
  readonly reasonCode: string
  readonly observedAt: string
}
export type SubagentControlSettled = DelegationIdentity & {
  readonly control: SessionEventId
  readonly business: 'not-started' | 'terminal'
  readonly root: SessionEventId | null
  readonly executionRelease: SessionEventId | null
  readonly reasonCode: string
}
/** Cross-Session observations carry public identities and state only, never result or question text. */
export type SubagentSettlementObserved = DelegationIdentity & {
  readonly deliveryFailures: readonly SessionEventId[]
  readonly childThrough: SessionLogPosition
  readonly business:
    | { readonly kind: 'pending' }
    | { readonly kind: 'not-started'; readonly control: SessionEventId }
    | { readonly kind: 'terminal'; readonly root: SessionEventId; readonly terminal: SessionEventId; readonly outcome: AgentRootOutcome }
  readonly resources: readonly { readonly opened: SessionEventId; readonly component: 'execution' | 'protocol'; readonly generation: number;
    readonly release: SessionEventId | null; readonly outcome: 'pending' | 'released' | 'cleanup-incomplete' | 'unknown' }[]
  readonly protocol: { readonly pendingIntents: number; readonly pendingOutbox: number; readonly pendingInbox: number; readonly pendingControls: number }
  readonly evidence: readonly SessionEventId[]
  readonly modelUsage: { readonly settled: number; readonly partialOrUnknown: number; readonly inputTokens: number | null; readonly outputTokens: number | null }
}
export type SubagentRecoveryRequested = DelegationIdentity & {
  readonly through: SessionLogPosition
  readonly predecessorStopped: true
  readonly supersedes: SessionEventId | null
  readonly maxWrites: number
}
export type SubagentRecoverySettled = DelegationIdentity & {
  readonly recovery: SessionEventId
  readonly writes: number
  readonly outcome: 'complete' | 'incomplete' | 'blocked'
  readonly pending: readonly string[]
  readonly evidence: readonly SessionEventId[]
}

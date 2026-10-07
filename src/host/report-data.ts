import type { AgentReadiness } from '../agent/readiness-data.js'
import type { AgentRunReport } from '../agent/report-data.js'
import type { SessionProjectionCoverage } from '../session/types.js'

export interface HostMemberReport {
  readonly agentKey: string
  readonly sessionId: string
  readonly paused: boolean
  readonly faulted: boolean
  readonly mailbox: 'online' | 'known-offline' | 'ended'
  readonly routingPaused: boolean
  readonly readiness: AgentReadiness
  readonly agent: AgentRunReport
}

export interface HostRunReport {
  readonly cuts?: readonly SessionProjectionCoverage[]
  readonly batches: number
  readonly businessRuns: number
  readonly maintenanceRuns: number
  readonly deliveryAttempts: number
  readonly stoppedBy: 'quiescent' | 'batch-budget' | 'no-progress' | 'aborted' | 'host-stopping'
  readonly blockedRoutes: readonly string[]
  readonly members: readonly HostMemberReport[]
  readonly counts: {
    readonly members: number; readonly pendingInputs: number; readonly pendingWaits: number; readonly pendingOutbox: number
    readonly pendingMaintenance: number; readonly runnableInputs: number; readonly reviewRequiredInputs: number
    readonly unsupportedInputs: number; readonly blockedMembers: number
    readonly failedRoots: number; readonly exhaustedRoots: number
  }
  readonly truncated: boolean
}

/** Current Host counters and bounded members, without owned handles. */
export interface HostCurrentReport {
  readonly status: 'ready' | 'stopping' | 'stopped' | 'failed'
  readonly shutdownMode: 'drain' | 'cancel' | null
  readonly hostKey: string
  readonly instanceId: string
  readonly configVersion: 1 | 2 | 3
  readonly configFingerprint: string
  readonly configuredMembers: number
  readonly remoteMembers: number
  readonly unfinishedOperations: number
  readonly shutdownOverdue: boolean
  readonly blockedRoutes: readonly string[]
  readonly members: readonly HostMemberReport[]
  readonly counts: HostRunReport['counts']
  readonly truncated: boolean
  readonly cuts: readonly SessionProjectionCoverage[]
}

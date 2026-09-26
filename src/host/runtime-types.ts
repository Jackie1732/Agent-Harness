import type { SessionAgent } from '../agent/session-agent.js'
import type { AgentReadiness } from '../agent/readiness.js'
import type { AgentRunReport } from '../agent/report.js'
import type { OutboxDispatcher } from '../communication/dispatcher.js'
import type { SessionMailbox } from '../communication/mailbox.js'
import type { ModelProvider } from '../model/contract.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { ResolvedHostLocalMember } from './config.js'
import type { HostToolResources } from './tool-factory.js'

export type HostProtocolSlot = Omit<Pick<HostSlot, 'member' | 'session' | 'mailbox' | 'dispatcher'>, 'member'>
  & { readonly member: { readonly agentKey: string } }

export interface HostSlot {
  readonly member: ResolvedHostLocalMember
  readonly session: SessionHandle
  readonly mailbox: SessionMailbox
  readonly dispatcher: OutboxDispatcher
  readonly provider: ModelProvider
  readonly tools?: HostToolResources
  readonly agent: SessionAgent
  dispose(): Promise<void>
}

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

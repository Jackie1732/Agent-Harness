import type { SessionAgent } from '../agent/session-agent.js'
import type { OutboxDispatcher } from '../communication/dispatcher.js'
import type { SessionMailbox } from '../communication/mailbox.js'
import type { ModelProvider } from '../model/contract.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { ResolvedHostLocalMember } from './config.js'
import type { HostToolResources } from './tool-factory.js'
import type { HostExecutionExtensions } from './slot.js'
import type { AgentRunSelection } from '../agent/contract.js'

export interface HostExecutionControl {
  readonly generation: number
  replace(selection: AgentRunSelection, extensions: HostExecutionExtensions): Promise<HostSlot>
  release(): Promise<void>
}

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
  readonly selection?: AgentRunSelection
  readonly executions?: HostExecutionControl
  dispose(): Promise<void>
}

export type { HostMemberReport, HostRunReport } from './report-data.js'

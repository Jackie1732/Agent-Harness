import type { AgentActionReference, AgentBudget } from '../agent/contract.js'
import type { ChannelId } from '../communication/ids.js'
import type { ModelIntentReference } from '../model/contract.js'
import type { SessionAddress, SessionEventId, SessionId, SessionLogPosition } from '../session/ids.js'
import type { DelegationMailboxReserve, DelegationRequest, DelegationWorkspace } from './contract.js'
import type { ChildTemplate } from './template.js'
import type { MessageSendCommand } from '../communication/send-command.js'
import type { SubagentMessageKind } from './messages.js'

/** An EventId is an identity, never an authorization handle. */
export type DelegationId = SessionEventId
export type DelegationSource =
  | { readonly kind: 'model'; readonly intent: ModelIntentReference; readonly action: AgentActionReference }
  | { readonly kind: 'programmatic'; readonly requestKey: string }
export type DelegationPlan = {
  readonly template: ChildTemplate
  readonly workspace: DelegationWorkspace
  readonly childBudget: AgentBudget
  readonly deadline: string
}
export type DelegationRequested = {
  readonly parentAddress: SessionAddress
  readonly childAddress: SessionAddress
  readonly childSessionId: SessionId
  readonly channelId: ChannelId
  readonly parentRoot: SessionEventId
  readonly source: DelegationSource
  readonly request: DelegationRequest
  readonly effectivePlan: DelegationPlan
  readonly grant: AgentBudget
  readonly parentProtocolReserve: AgentBudget
  readonly childProtocolReserve: AgentBudget
  readonly mailboxReserve: DelegationMailboxReserve
  readonly deadline: string
  readonly observedAt: string
}
export type DelegationIdentity = {
  readonly delegation: DelegationId
  readonly parentAddress: SessionAddress
  readonly childAddress: SessionAddress
}
export type ChildBound = DelegationIdentity & { readonly requested: DelegationRequested }
export type ChildReady = DelegationIdentity & {
  readonly bound: SessionEventId
  readonly profile: SessionEventId
  readonly spec: SessionEventId
  readonly through: SessionLogPosition
}
export type SubagentResourceOpened = DelegationIdentity & {
  readonly generation: number
  readonly component: 'execution' | 'protocol'
  readonly predecessor: SessionEventId | null
  readonly recovery: SessionEventId | null
  readonly workspaceGrant: DelegationWorkspace
}
export type SubagentReleaseRecorded = DelegationIdentity & {
  readonly opened: SessionEventId
  readonly component: 'execution' | 'protocol'
  readonly outcome: 'released' | 'cleanup-incomplete' | 'unknown'
  readonly reasonCode: string
}
export type SubagentProtocolRecorded = DelegationIdentity & {
  readonly kind: SubagentMessageKind
  readonly ordinal: number
  readonly command: MessageSendCommand
  readonly source:
    | { readonly kind: 'action'; readonly action: AgentActionReference; readonly intent: ModelIntentReference }
    | { readonly kind: 'delegation'; readonly requested: SessionEventId }
    | { readonly kind: 'terminal'; readonly turn: SessionEventId; readonly release: SessionEventId }
  readonly observedAt: string
}
export type SubagentMessageClassified = DelegationIdentity & {
  readonly inbox: SessionEventId
  readonly kind: SubagentMessageKind
  readonly classification: 'eligible' | 'progress-only' | 'rejected'
  readonly reasonCode: string
}
export type SubagentInputDisposed = DelegationIdentity & {
  readonly input: SessionEventId
  readonly disposition: 'handled' | 'not-adopted'
  readonly reasonCode: string
}

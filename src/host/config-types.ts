import type { AgentSpec } from '../agent/contract.js'
import type { MailboxLimits } from '../communication/types.js'
import type { ChannelId } from '../communication/ids.js'
import type { ContextModelTarget, ContextProfile } from '../context/contract.js'
import type { JsonObject } from '../foundation/json.js'
import type { SessionId } from '../session/ids.js'
import type { ModelRunnerLimits, ModelStreamLimits } from '../model/contract.js'
import type { HttpsMessageLimits } from '../communication/https-transport.js'
import type { ToolInvocationLimits, ToolSchemaLimits } from '../tool/contract.js'

export interface HostIdentitySource {
  nextSessionId(): SessionId
  nextChannelId(): ChannelId
}

export interface HostPeerConfig {
  readonly key: string
  readonly memberKey: string
  readonly channelKey: string
}
export interface HostAgentSpecTemplate {
  readonly protocolVersion: 1
  readonly label: string
  readonly responsibility: string
  readonly nonGoals: readonly string[]
  readonly target: Omit<ContextModelTarget, 'provider'>
  readonly toolNames: readonly string[]
  readonly nativeActions: AgentSpec['nativeActions']
  readonly peers: readonly HostPeerConfig[]
  readonly messages: AgentSpec['messages']
  readonly context: AgentSpec['context']
  readonly budget: AgentSpec['budget']
  readonly rootDurationMs: number
  readonly maxDirectSendCommandsPerSession: number
  readonly limits: AgentSpec['limits']
  readonly errorFeedback: AgentSpec['errorFeedback']
  readonly usagePolicy: AgentSpec['usagePolicy']
  readonly businessRefusalHandled: boolean
}
export interface HostScriptedModelConfig {
  readonly kind: 'scripted-fixed'
  readonly providerId: string
  readonly text: string
  readonly maxConcurrentExchanges: number
  readonly streamLimits: ModelStreamLimits
  readonly runnerLimits: ModelRunnerLimits
}
export interface HostHttpModelConfig {
  readonly kind: 'deepseek' | 'anthropic'
  readonly providerId: string
  readonly endpoint: string
  readonly credentialRef: string
  readonly maxConcurrentExchanges: number
  readonly streamLimits: ModelStreamLimits
  readonly runnerLimits: ModelRunnerLimits
}
export type HostModelConfig = HostScriptedModelConfig | HostHttpModelConfig
export type HostToolConfig =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'workspace-read-text'
    readonly rootId: string
    readonly rootPath: string
    readonly protectedRoots: readonly string[]
    readonly maxReadBytes: number
    readonly maxPathBytes: number
    readonly maxArgumentsBytes: number
    readonly maxResultBytes: number
    readonly schemaLimits: ToolSchemaLimits
    readonly invocationLimits: ToolInvocationLimits
    readonly policy: {
      readonly policyId: string
      readonly version: number
      readonly decision: 'allow' | 'deny'
      readonly reasonCode: string
    }
  }
export interface HostLocalMemberConfig {
  readonly kind: 'local'
  readonly agentKey: string
  readonly sessionId: string | null
  readonly mode: 'create' | 'adopt'
  readonly enabled: boolean
  readonly profile: ContextProfile
  readonly spec: HostAgentSpecTemplate
  readonly model: HostModelConfig
  readonly tools: HostToolConfig
}
export interface HostRemoteMemberConfig {
  readonly kind: 'remote'
  readonly agentKey: string
  readonly sessionId: string
  readonly ownerHost: string
}
export type HostMemberConfig = HostLocalMemberConfig | HostRemoteMemberConfig
export interface HostMessageConfig {
  readonly type: string
  readonly payloadVersion: number
  readonly schema: JsonObject
}
export interface HostChannelConfig {
  readonly channelKey: string
  readonly channelId: string | null
}
export interface HostRouteConfig {
  readonly memberKey: string
  readonly ownerHost: string
  readonly origin: string | null
  readonly serverName: string | null
}
export interface ResolvedHostRoute extends HostRouteConfig { readonly sessionId: string }
export type HostHttpsConfig =
  | { readonly kind: 'disabled' }
  | {
    readonly kind: 'mutual-tls'
    readonly listen: { readonly host: string; readonly port: number }
    readonly caFile: string
    readonly serverCertFile: string
    readonly serverKeyFile: string
    readonly clientCertFile: string
    readonly clientKeyFile: string
    readonly peers: readonly { readonly hostKey: string; readonly fingerprint256: string; readonly sessionIds: readonly string[] }[]
    readonly limits: HttpsMessageLimits
  }
export interface HostSchedulingConfig {
  readonly scanIntervalMs: number
  /** Maximum members examined per lane page and per independent deadline page. */
  readonly maxSlotsPerScan: number
  readonly maxBatchesPerRun: number
  readonly maxNoProgressBatches: number
  readonly retryIntervalMs: number
  readonly maxReportEntries: number
}
export interface HostCliConfig {
  readonly maxLineBytes: number
  readonly maxQueuedCommands: number
  readonly maxPendingControls: number
  readonly maxOutputBytes: number
  readonly outputDrainTimeoutMs: number
}
export interface HostConfig {
  readonly schemaVersion: 1
  readonly hostKey: string
  readonly storage: { readonly root: string; readonly maxRecordBytes: number; readonly maxLineageDepth: number }
  readonly members: readonly HostMemberConfig[]
  readonly messages: readonly HostMessageConfig[]
  readonly channels: readonly HostChannelConfig[]
  readonly routes: readonly HostRouteConfig[]
  readonly https: HostHttpsConfig
  readonly communication: MailboxLimits
  readonly scheduling: HostSchedulingConfig
  readonly cli: HostCliConfig
  readonly shutdown: { readonly mode: 'drain' | 'cancel'; readonly diagnosticAfterMs: number }
}
export interface ResolvedHostLocalMember extends Omit<HostLocalMemberConfig, 'sessionId' | 'spec'> {
  readonly sessionId: string
  readonly spec: Omit<AgentSpec, 'profileEventId'>
}
export type ResolvedHostMember = ResolvedHostLocalMember | HostRemoteMemberConfig
export interface ResolvedHostSpec extends Omit<HostConfig, 'members' | 'channels' | 'routes'> {
  readonly members: readonly ResolvedHostMember[]
  readonly channels: readonly { readonly channelKey: string; readonly channelId: string }[]
  readonly routes: readonly ResolvedHostRoute[]
}

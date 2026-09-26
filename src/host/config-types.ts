import type { HostSubagentConfig, HostSubagentConfigV3, HostWorkspaceResource } from './subagent-config.js'
import type { HostWorkflowConfig, ResolvedHostWorkflowConfig } from './workflow-config.js'
import type { AgentSpec, AgentSpecV1, AgentSpecV2, AgentSpecV3 } from '../agent/contract.js'
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
interface HostAgentSpecTemplateFields {
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
export type HostAgentSpecTemplate = HostAgentSpecTemplateFields & (
  { readonly protocolVersion: 1 | 2 } | { readonly protocolVersion: 3; readonly workflow: AgentSpecV3['workflow'] }
)
export interface HostScriptedModelConfig extends JsonObject {
  readonly kind: 'scripted-fixed'
  readonly providerId: string
  readonly text: string
  readonly maxConcurrentExchanges: number
  readonly streamLimits: ModelStreamLimits
  readonly runnerLimits: ModelRunnerLimits
}
export interface HostHttpModelConfig extends JsonObject {
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
  readonly workflowTools?: import('./workflow-tools.js').HostWorkflowTools
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
export interface HostConfigV1 {
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
  readonly spec: Omit<AgentSpecV1, 'profileEventId'> | Omit<AgentSpecV2, 'profileEventId'> | Omit<AgentSpecV3, 'profileEventId'>
}
export type ResolvedHostMember = ResolvedHostLocalMember | HostRemoteMemberConfig
export type HostConfigV2 = Omit<HostConfigV1, 'schemaVersion'> & { readonly schemaVersion: 2; readonly subagents: HostSubagentConfig }
export type HostConfigV3 = Omit<HostConfigV1, 'schemaVersion'> & {
  readonly schemaVersion: 3
  readonly subagents: HostSubagentConfigV3
  readonly workspaceResources: readonly HostWorkspaceResource[]
  readonly workflows: HostWorkflowConfig
}
export type HostConfig = HostConfigV1 | HostConfigV2 | HostConfigV3
export type ResolvedHostSpec = (Omit<HostConfigV1, 'members' | 'channels' | 'routes'>
  | Omit<HostConfigV2, 'members' | 'channels' | 'routes'>
  | (Omit<HostConfigV3, 'members' | 'channels' | 'routes' | 'workflows'> & { readonly workflows: ResolvedHostWorkflowConfig })) & {
  readonly members: readonly ResolvedHostMember[]
  readonly channels: readonly { readonly channelKey: string; readonly channelId: string }[]
  readonly routes: readonly ResolvedHostRoute[]
}

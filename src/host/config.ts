import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { AgentSpec } from '../agent/contract.js'
import { decodeAgentSpec } from '../agent/spec-codec.js'
import type { MailboxLimits } from '../communication/types.js'
import { parseChannelId } from '../communication/ids.js'
import type { ChannelId } from '../communication/ids.js'
import type { ContextModelTarget, ContextProfile } from '../context/contract.js'
import { decodeAgentContextProfile } from '../context/profile.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { formatSessionAddress, parseSessionId } from '../session/ids.js'
import type { SessionId } from '../session/ids.js'
import { boundedJson, parseBoundedJson } from '../schema/bounded-json.js'
import type { JsonValidationLimits } from '../schema/bounded-json.js'
import { validateInlineSchema } from '../schema/inline.js'
import type { ModelRunnerLimits, ModelStreamLimits } from '../model/contract.js'
import type { HttpsMessageLimits } from '../communication/https-transport.js'
import type { ToolInvocationLimits, ToolSchemaLimits } from '../tool/contract.js'
import { scriptedModelDescriptor } from '../model/providers/scripted.js'
import { deepSeekModelDescriptor } from '../model/providers/deepseek.js'
import { anthropicModelDescriptor } from '../model/providers/anthropic.js'
import { HostError } from './errors.js'

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

const keys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => {
  if (Object.keys(value).some(key => !expected.includes(key)) || expected.some(key => !Object.hasOwn(value, key))) invalid(`${label}-fields`)
}
const record = (value: unknown, label: string): Record<string, JsonValue> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}-object`)
  return value as Record<string, JsonValue>
}
const array = (value: unknown, label: string, maximum = 256): readonly JsonValue[] => {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label}-array`)
  return value
}
const text = (value: unknown, label: string, maximum = 256): string => {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum) invalid(`${label}-text`)
  return value
}
const integer = (value: unknown, label: string, minimum = 1): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(`${label}-integer`)
  return value as number
}
const identifier = (value: unknown, label: string): string => {
  const result = text(value, label, 128)
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(result)) invalid(`${label}-identifier`)
  return result
}
function invalid(reason: string): never { throw new HostError('HOST_CONFIG_INVALID', reason) }
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label}-duplicate`)
}

function assertDataOnly(value: unknown, seen = new WeakSet<object>(), depth = 0): void {
  if (value === null || typeof value !== 'object') return
  if (depth > HOST_CONFIG_LIMITS.maxDepth || seen.has(value)) invalid('programmatic-object')
  seen.add(value)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) invalid('programmatic-object')
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) invalid('programmatic-accessor')
    assertDataOnly(descriptor.value, seen, depth + 1)
  }
  seen.delete(value)
}

export const HOST_CONFIG_LIMITS: JsonValidationLimits = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDepth: 64, maxNodes: 100_000 })

/** Parse a bounded UTF-8 Host configuration. */
export function parseHostConfig(textValue: string, baseDirectory: string, limits: JsonValidationLimits = HOST_CONFIG_LIMITS): HostConfig {
  return decodeHostConfig(parseBoundedJson(textValue, limits), baseDirectory, limits)
}

/** Validate one data-only Host configuration without acquiring resources. */
export function decodeHostConfig(value: unknown, baseDirectory: string, limits: JsonValidationLimits = HOST_CONFIG_LIMITS): HostConfig {
  assertDataOnly(value)
  const input = record(boundedJson(value, limits), 'host')
  keys(input, ['schemaVersion', 'hostKey', 'storage', 'members', 'messages', 'channels', 'routes', 'https', 'communication', 'scheduling', 'cli'], 'host')
  if (input.schemaVersion !== 1) invalid('schema-version')
  const hostKey = identifier(input.hostKey, 'hostKey')
  const storage = record(input.storage, 'storage'); keys(storage, ['root', 'maxRecordBytes', 'maxLineageDepth'], 'storage')
  const rootInput = text(storage.root, 'storage.root', 4096)
  const root = isAbsolute(rootInput) ? resolve(rootInput) : resolve(baseDirectory, rootInput)
  const members = array(input.members, 'members').map((item, index) => decodeMember(item, index, baseDirectory))
  const messages = array(input.messages, 'messages').map(item => {
    const message = record(item, 'message'); keys(message, ['type', 'payloadVersion', 'schema'], 'message')
    const schema = record(message.schema, 'message.schema') as JsonObject; validateInlineSchema(schema)
    return Object.freeze({ type: text(message.type, 'message.type', 128), payloadVersion: integer(message.payloadVersion, 'message.payloadVersion'), schema })
  })
  const channels = array(input.channels, 'channels').map(item => {
    const channel = record(item, 'channel'); keys(channel, ['channelKey', 'channelId'], 'channel')
    const channelId = channel.channelId === null ? null : parseChannelId(text(channel.channelId, 'channelId'))
    return Object.freeze({ channelKey: identifier(channel.channelKey, 'channelKey'), channelId })
  })
  const routes = array(input.routes, 'routes').map(item => {
    const route = record(item, 'route'); keys(route, ['memberKey', 'ownerHost', 'origin', 'serverName'], 'route')
    const parsedOrigin = route.origin === null ? null : new URL(text(route.origin, 'route.origin', 2048))
    if (parsedOrigin !== null && (parsedOrigin.protocol !== 'https:' || parsedOrigin.username !== '' || parsedOrigin.password !== ''
      || parsedOrigin.pathname !== '/' || parsedOrigin.search !== '' || parsedOrigin.hash !== '')) invalid('route-origin')
    const origin = parsedOrigin?.origin ?? null
    const serverName = route.serverName === null ? null : text(route.serverName, 'route.serverName', 253)
    if ((origin === null) !== (serverName === null)) invalid('route-remote-fields')
    return Object.freeze({ memberKey: identifier(route.memberKey, 'route.memberKey'), ownerHost: identifier(route.ownerHost, 'route.ownerHost'), origin, serverName })
  })
  const https = decodeHttps(input.https, baseDirectory)
  const communication = decodeIntegerRecord(input.communication, ['maxMessageBytes', 'maxPendingOutbox', 'maxPendingInbox', 'maxDeliveryAttempts', 'maxAttemptsPerRun', 'maxSendJournalConflicts'],
    'communication', new Set(['maxPendingOutbox', 'maxPendingInbox', 'maxSendJournalConflicts'])) as unknown as MailboxLimits
  if (communication.maxAttemptsPerRun > communication.maxDeliveryAttempts) invalid('communication-attempt-budget')
  const scheduling = decodeIntegerRecord(input.scheduling, ['scanIntervalMs', 'maxSlotsPerScan', 'maxBatchesPerRun', 'maxNoProgressBatches', 'retryIntervalMs', 'maxReportEntries'], 'scheduling') as unknown as HostSchedulingConfig
  const cli = decodeIntegerRecord(input.cli, ['maxLineBytes', 'maxQueuedCommands', 'maxPendingControls', 'maxOutputBytes', 'outputDrainTimeoutMs'], 'cli') as unknown as HostCliConfig
  unique(members.map(member => member.agentKey), 'agentKey'); unique(channels.map(channel => channel.channelKey), 'channelKey')
  unique(messages.map(message => `${message.type}@${message.payloadVersion}`), 'message')
  unique(routes.map(route => route.memberKey), 'route')
  const memberIds = members.flatMap(member => member.sessionId === null ? [] : [member.sessionId])
  unique(memberIds, 'sessionId')
  const channelKeys = new Set(channels.map(channel => channel.channelKey)); const memberKeys = new Set(members.map(member => member.agentKey))
  for (const member of members) if (member.kind === 'local') for (const peer of member.spec.peers) {
    if (!memberKeys.has(peer.memberKey) || !channelKeys.has(peer.channelKey)) invalid('peer-reference')
  }
  if (routes.length !== members.length || members.some(member => {
    const route = routes.find(item => item.memberKey === member.agentKey)
    return route === undefined || route.ownerHost !== (member.kind === 'local' ? hostKey : member.ownerHost)
      || member.kind === 'local' && route.origin !== null || member.kind === 'remote' && route.origin === null
  })) invalid('route-ownership')
  if (https.kind === 'disabled' && routes.some(route => route.origin !== null)) invalid('https-disabled-with-remote-route')
  return snapshotJson({ schemaVersion: 1, hostKey, storage: { root, maxRecordBytes: integer(storage.maxRecordBytes, 'maxRecordBytes', 4096),
    maxLineageDepth: integer(storage.maxLineageDepth, 'maxLineageDepth', 0) }, members, messages, channels, routes,
    https, communication, scheduling, cli }) as unknown as HostConfig
}

function decodeHttps(value: unknown, baseDirectory: string): HostHttpsConfig {
  const input = record(value, 'https')
  if (input.kind === 'disabled') { keys(input, ['kind'], 'https'); return Object.freeze({ kind: 'disabled' }) }
  if (input.kind !== 'mutual-tls') invalid('https-kind')
  keys(input, ['kind', 'listen', 'caFile', 'serverCertFile', 'serverKeyFile', 'clientCertFile', 'clientKeyFile', 'peers', 'limits'], 'https')
  const listen = record(input.listen, 'https.listen'); keys(listen, ['host', 'port'], 'https.listen')
  const file = (field: 'caFile' | 'serverCertFile' | 'serverKeyFile' | 'clientCertFile' | 'clientKeyFile') => {
    const inputPath = text(input[field], `https.${field}`, 4096)
    return isAbsolute(inputPath) ? resolve(inputPath) : resolve(baseDirectory, inputPath)
  }
  const peers = array(input.peers, 'https.peers').map(value => {
    const peer = record(value, 'https.peer'); keys(peer, ['hostKey', 'fingerprint256', 'sessionIds'], 'https.peer')
    const fingerprint256 = text(peer.fingerprint256, 'https.fingerprint256', 95)
    if (!/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint256)) invalid('https-fingerprint')
    const sessionIds = array(peer.sessionIds, 'https.sessionIds').map(value => parseSessionId(text(value, 'https.sessionId')))
    unique(sessionIds, 'https-sessionId')
    return Object.freeze({ hostKey: identifier(peer.hostKey, 'https.peer.hostKey'), fingerprint256, sessionIds })
  })
  unique(peers.map(peer => `${peer.hostKey}\u0000${peer.fingerprint256}`), 'https-peer')
  const limits = decodeIntegerRecord(input.limits, ['maxHeaderBytes', 'maxBodyBytes', 'maxResponseBytes', 'maxConnections',
    'maxInFlightRequests', 'handshakeTimeoutMs', 'headersTimeoutMs', 'bodyTimeoutMs', 'requestTimeoutMs', 'idleTimeoutMs'], 'https.limits') as unknown as HttpsMessageLimits
  return Object.freeze({ kind: 'mutual-tls', listen: Object.freeze({ host: text(listen.host, 'https.listen.host', 253),
    port: integer(listen.port, 'https.listen.port') }), caFile: file('caFile'),
    serverCertFile: file('serverCertFile'), serverKeyFile: file('serverKeyFile'),
    clientCertFile: file('clientCertFile'), clientKeyFile: file('clientKeyFile'), peers, limits })
}

function decodeIntegerRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
  zeroFields: ReadonlySet<string> = new Set(),
): Record<string, number> {
  const input = record(value, label); keys(input, fields, label)
  return Object.freeze(Object.fromEntries(fields.map(field => [field, integer(input[field], `${label}.${field}`, zeroFields.has(field) ? 0 : 1)])))
}

function decodeMember(value: JsonValue, index: number, baseDirectory: string): HostMemberConfig {
  const member = record(value, `members[${index}]`)
  if (member.kind === 'remote') {
    keys(member, ['kind', 'agentKey', 'sessionId', 'ownerHost'], 'member')
    return Object.freeze({ kind: 'remote', agentKey: identifier(member.agentKey, 'agentKey'),
      sessionId: parseSessionId(text(member.sessionId, 'member.sessionId')), ownerHost: identifier(member.ownerHost, 'member.ownerHost') })
  }
  if (member.kind !== 'local') invalid('member-kind')
  keys(member, ['kind', 'agentKey', 'sessionId', 'mode', 'enabled', 'profile', 'spec', 'model', 'tools'], 'member')
  const mode = member.mode
  if (mode !== 'create' && mode !== 'adopt') invalid('member-mode')
  if (typeof member.enabled !== 'boolean') invalid('member-enabled')
  const sessionId = member.sessionId === null ? null : parseSessionId(text(member.sessionId, 'member.sessionId'))
  if (mode === 'adopt' && sessionId === null) invalid('adopt-session-id')
  const profile = decodeAgentContextProfile(member.profile)
  const model = record(member.model, 'model')
  if (model.kind !== 'scripted-fixed' && model.kind !== 'deepseek' && model.kind !== 'anthropic') invalid('model-kind')
  const modelKind: HostModelConfig['kind'] = model.kind
  const modelFields = modelKind === 'scripted-fixed'
    ? ['kind', 'providerId', 'text', 'maxConcurrentExchanges', 'streamLimits', 'runnerLimits']
    : ['kind', 'providerId', 'endpoint', 'credentialRef', 'maxConcurrentExchanges', 'streamLimits', 'runnerLimits']
  keys(model, modelFields, 'model')
  const streamLimits = decodeIntegerRecord(model.streamLimits, ['maxFrameBytes', 'maxStreamBytes', 'maxFrames'], 'streamLimits') as unknown as ModelStreamLimits
  const runnerLimits = decodeIntegerRecord(model.runnerLimits, ['maxInputBytes', 'maxNormalizedResultBytes', 'maxOutputBlocks', 'maxToolCalls', 'maxJournalConflicts'],
    'runnerLimits', new Set(['maxToolCalls', 'maxJournalConflicts'])) as unknown as ModelRunnerLimits
  const spec = record(member.spec, 'spec') as unknown as HostAgentSpecTemplate
  const specKeys = ['protocolVersion', 'label', 'responsibility', 'nonGoals', 'target', 'toolNames', 'nativeActions', 'peers', 'messages', 'context', 'budget',
    'rootDurationMs', 'maxDirectSendCommandsPerSession', 'limits', 'errorFeedback', 'usagePolicy', 'businessRefusalHandled']
  keys(spec as unknown as Record<string, unknown>, specKeys, 'spec')
  const common = { providerId: identifier(model.providerId, 'providerId'),
    maxConcurrentExchanges: integer(model.maxConcurrentExchanges, 'maxConcurrentExchanges'), streamLimits, runnerLimits }
  const modelConfig: HostModelConfig = modelKind === 'scripted-fixed'
    ? Object.freeze({ kind: 'scripted-fixed', ...common, text: text(model.text, 'model.text', 65536) })
    : Object.freeze({ kind: modelKind, ...common, endpoint: text(model.endpoint, 'model.endpoint', 2048),
      credentialRef: identifier(model.credentialRef, 'model.credentialRef') })
  const tools = decodeTools(member.tools, baseDirectory)
  const expectedToolNames = tools.kind === 'none' ? [] : ['read_text']
  if (JSON.stringify(profile.toolNames) !== JSON.stringify(expectedToolNames)
    || JSON.stringify(spec.toolNames) !== JSON.stringify(expectedToolNames)) invalid('tool-names-binding')
  return Object.freeze({ kind: 'local', agentKey: identifier(member.agentKey, 'agentKey'), sessionId, mode, enabled: member.enabled,
    profile, spec: snapshotJson(spec) as unknown as HostAgentSpecTemplate,
    model: modelConfig, tools })
}

function decodeTools(value: JsonValue | undefined, baseDirectory: string): HostToolConfig {
  const input = record(value, 'tools')
  if (input.kind === 'none') {
    keys(input, ['kind'], 'tools')
    return Object.freeze({ kind: 'none' })
  }
  if (input.kind !== 'workspace-read-text') invalid('tools-kind')
  keys(input, ['kind', 'rootId', 'rootPath', 'protectedRoots', 'maxReadBytes', 'maxPathBytes', 'maxArgumentsBytes',
    'maxResultBytes', 'schemaLimits', 'invocationLimits', 'policy'], 'tools')
  const resolvePath = (value: JsonValue | undefined, label: string) => {
    const inputPath = text(value, label, 4096)
    return isAbsolute(inputPath) ? resolve(inputPath) : resolve(baseDirectory, inputPath)
  }
  const schemaLimits = decodeIntegerRecord(input.schemaLimits,
    ['maxSchemaBytes', 'maxSchemaDepth', 'maxSchemaNodes'], 'tools.schemaLimits') as unknown as ToolSchemaLimits
  const invocationLimits = decodeIntegerRecord(input.invocationLimits,
    ['maxSchemaBytes', 'maxSchemaDepth', 'maxSchemaNodes', 'maxRequestBytes', 'maxPlanBytes', 'maxArgumentsBytes',
      'maxJsonDepth', 'maxJsonNodes', 'maxResultBytes', 'maxJournalConflicts'],
    'tools.invocationLimits', new Set(['maxJournalConflicts'])) as unknown as ToolInvocationLimits
  if (invocationLimits.maxSchemaBytes !== schemaLimits.maxSchemaBytes
    || invocationLimits.maxSchemaDepth !== schemaLimits.maxSchemaDepth
    || invocationLimits.maxSchemaNodes !== schemaLimits.maxSchemaNodes) invalid('tools-schema-limits-mismatch')
  const maxArgumentsBytes = integer(input.maxArgumentsBytes, 'tools.maxArgumentsBytes')
  const maxResultBytes = integer(input.maxResultBytes, 'tools.maxResultBytes')
  if (invocationLimits.maxArgumentsBytes > maxArgumentsBytes || invocationLimits.maxResultBytes > maxResultBytes) {
    invalid('tools-invocation-provider-limits')
  }
  const policy = record(input.policy, 'tools.policy')
  keys(policy, ['policyId', 'version', 'decision', 'reasonCode'], 'tools.policy')
  if (policy.decision !== 'allow' && policy.decision !== 'deny') invalid('tools-policy-decision')
  return Object.freeze({
    kind: 'workspace-read-text',
    rootId: identifier(input.rootId, 'tools.rootId'),
    rootPath: resolvePath(input.rootPath, 'tools.rootPath'),
    protectedRoots: Object.freeze(array(input.protectedRoots, 'tools.protectedRoots', 64)
      .map((item, index) => resolvePath(item, `tools.protectedRoots[${index}]`))),
    maxReadBytes: integer(input.maxReadBytes, 'tools.maxReadBytes'),
    maxPathBytes: integer(input.maxPathBytes, 'tools.maxPathBytes'),
    maxArgumentsBytes,
    maxResultBytes,
    schemaLimits,
    invocationLimits,
    policy: Object.freeze({
      policyId: identifier(policy.policyId, 'tools.policyId'),
      version: integer(policy.version, 'tools.policyVersion'),
      decision: policy.decision,
      reasonCode: identifier(policy.reasonCode, 'tools.policyReasonCode'),
    }),
  })
}

/** Fill reserved identities without reading storage or creating any runtime object. */
export function planHostConfig(config: HostConfig, identities: HostIdentitySource = {
  nextSessionId: () => parseSessionId(randomUUID()), nextChannelId: () => parseChannelId(randomUUID()),
}): HostConfig {
  const members = config.members.map(member => member.kind === 'local' && member.sessionId === null ? { ...member, sessionId: identities.nextSessionId() } : member)
  const channels = config.channels.map(channel => channel.channelId === null ? { ...channel, channelId: identities.nextChannelId() } : channel)
  return decodeHostConfig({ ...config, members, channels }, config.storage.root)
}

/** Resolve peer references and the exact Provider descriptor persisted in each AgentSpec. */
export function resolveHostConfig(config: HostConfig): ResolvedHostSpec {
  if (config.members.some(member => member.kind === 'local' && member.sessionId === null) || config.channels.some(channel => channel.channelId === null)) invalid('unplanned-identity')
  const members = new Map(config.members.map(member => [member.agentKey, member]))
  const channels = new Map(config.channels.map(channel => [channel.channelKey, channel.channelId!]))
  const resolved = config.members.map(member => {
    if (member.kind === 'remote') return member
    const descriptor = member.model.kind === 'scripted-fixed'
      ? scriptedModelDescriptor(member.model)
      : member.model.kind === 'deepseek' ? deepSeekModelDescriptor(member.model) : anthropicModelDescriptor(member.model)
    const peers = member.spec.peers.map(peer => ({ key: peer.key,
      address: formatSessionAddress(parseSessionId(members.get(peer.memberKey)!.sessionId!)), channelId: parseChannelId(channels.get(peer.channelKey)!) }))
    const provisional = { ...member.spec, profileEventId: 'ah-event:00000000-0000-4000-8000-000000000000:1',
      target: { ...member.spec.target, provider: descriptor }, peers }
    const { profileEventId: _profileEventId, ...spec } = decodeAgentSpec(provisional)
    return Object.freeze({ ...member, sessionId: parseSessionId(member.sessionId!), spec })
  })
  const routes = config.routes.map(route => ({ ...route, sessionId: members.get(route.memberKey)!.sessionId! }))
  return snapshotJson({ ...config, members: resolved, routes,
    channels: config.channels.map(channel => ({ channelKey: channel.channelKey, channelId: channel.channelId! })) }) as unknown as ResolvedHostSpec
}

export function isLocalHostMember(member: ResolvedHostMember): member is ResolvedHostLocalMember {
  return member.kind === 'local'
}

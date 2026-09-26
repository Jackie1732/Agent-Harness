import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { decodeHostSubagents, decodeHostWorkspaceResources, parentSubagentRole } from './subagent-config.js'
import { decodeHostWorkflows } from './workflow-config.js'
import { decodeAgentSpec, decodeSubagentAgentSpec } from '../agent/spec-codec.js'
import type { MailboxLimits } from '../communication/types.js'
import { parseChannelId } from '../communication/ids.js'
import { decodeAgentContextProfile, decodeSubagentContextProfile } from '../context/profile.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { formatSessionAddress, parseSessionId } from '../session/ids.js'
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

import type { HostIdentitySource, HostAgentSpecTemplate, HostModelConfig, HostToolConfig, HostMemberConfig, HostHttpsConfig, HostSchedulingConfig, HostCliConfig, HostConfig, ResolvedHostLocalMember, ResolvedHostMember, ResolvedHostSpec } from './config-types.js'
export type * from './config-types.js'

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

export const HOST_CONFIG_LIMITS: JsonValidationLimits = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDepth: 64, maxNodes: 100_000 })

/** Parse a bounded UTF-8 Host configuration. */
export function parseHostConfig(textValue: string, baseDirectory: string, limits: JsonValidationLimits = HOST_CONFIG_LIMITS): HostConfig {
  let value: JsonValue
  try { value = parseBoundedJson(textValue, limits) } catch { invalid('config-json-limits') }
  return decodeHostConfig(value, baseDirectory, limits)
}

/** Validate one data-only Host configuration without acquiring resources. */
export function decodeHostConfig(value: unknown, baseDirectory: string, limits: JsonValidationLimits = HOST_CONFIG_LIMITS): HostConfig {
  try { return decodeConfig(value, baseDirectory, limits) }
  catch (cause) {
    if (cause instanceof HostError) throw cause
    throw new HostError('HOST_CONFIG_INVALID', 'invalid-config-field', {}, { cause })
  }
}

function decodeConfig(value: unknown, baseDirectory: string, limits: JsonValidationLimits): HostConfig {
  let data: JsonValue
  try { data = boundedJson(value, limits) } catch { invalid('config-json-limits') }
  const input = record(data, 'host')
  keys(input, ['schemaVersion', 'hostKey', 'storage', 'members', 'messages', 'channels', 'routes', 'https', 'communication', 'scheduling', 'cli', 'shutdown',
    ...(input.schemaVersion === 2 ? ['subagents'] : []),
    ...(input.schemaVersion === 3 ? ['subagents', 'workspaceResources', 'workflows'] : [])], 'host')
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2 && input.schemaVersion !== 3) invalid('schema-version')
  const workspaceResources = input.schemaVersion === 3 ? decodeHostWorkspaceResources(input.workspaceResources) : undefined
  const decodedSubagents = input.schemaVersion === 2 ? decodeHostSubagents(input.subagents)
    : input.schemaVersion === 3 ? decodeHostSubagents(input.subagents, workspaceResources) : undefined
  const subagents = input.schemaVersion === 3 && decodedSubagents?.kind === 'enabled'
    ? (({ workspaceResources: _resources, ...rest }) => rest)(decodedSubagents) : decodedSubagents
  const workflows = input.schemaVersion === 3 ? decodeHostWorkflows(input.workflows) : undefined
  const hostKey = identifier(input.hostKey, 'hostKey')
  const storage = record(input.storage, 'storage'); keys(storage, ['root', 'maxRecordBytes', 'maxLineageDepth'], 'storage')
  const rootInput = text(storage.root, 'storage.root', 4096)
  const root = isAbsolute(rootInput) ? resolve(rootInput) : resolve(baseDirectory, rootInput)
  const members = array(input.members, 'members').map((item, index) => decodeMember(item, index, baseDirectory, input.schemaVersion as 1 | 2 | 3))
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
  const scheduling = decodeIntegerRecord(input.scheduling, ['scanIntervalMs', 'maxSlotsPerScan', 'maxBatchesPerRun', 'maxNoProgressBatches', 'retryIntervalMs', 'maxReportEntries'], 'scheduling') as unknown as HostSchedulingConfig
  const cli = decodeIntegerRecord(input.cli, ['maxLineBytes', 'maxQueuedCommands', 'maxPendingControls', 'maxOutputBytes', 'outputDrainTimeoutMs'], 'cli') as unknown as HostCliConfig
  const shutdownInput = record(input.shutdown, 'shutdown'); keys(shutdownInput, ['mode', 'diagnosticAfterMs'], 'shutdown')
  if (shutdownInput.mode !== 'drain' && shutdownInput.mode !== 'cancel') invalid('shutdown-mode')
  const shutdown = { mode: shutdownInput.mode, diagnosticAfterMs: integer(shutdownInput.diagnosticAfterMs, 'shutdown.diagnosticAfterMs') }
  unique(members.map(member => member.agentKey), 'agentKey'); unique(channels.map(channel => channel.channelKey), 'channelKey')
  unique(channels.flatMap(channel => channel.channelId === null ? [] : [channel.channelId]), 'channelId')
  unique(messages.map(message => `${message.type}@${message.payloadVersion}`), 'message')
  unique(routes.map(route => route.memberKey), 'route')
  const memberIds = members.flatMap(member => member.sessionId === null ? [] : [member.sessionId])
  unique(memberIds, 'sessionId')
  const channelKeys = new Set(channels.map(channel => channel.channelKey)); const memberKeys = new Set(members.map(member => member.agentKey))
  for (const member of members) if (member.kind === 'local') for (const peer of member.spec.peers) {
    if (!memberKeys.has(peer.memberKey) || !channelKeys.has(peer.channelKey)) invalid('peer-reference')
  }
  for (const member of members) if (member.kind === 'local') {
    if (member.spec.messages.some(kind => !messages.some(message => message.type === kind.type && message.payloadVersion === kind.payloadVersion))) invalid('message-reference')
  }
  if (routes.length !== members.length || members.some(member => {
    const route = routes.find(item => item.memberKey === member.agentKey)
    return route === undefined || route.ownerHost !== (member.kind === 'local' ? hostKey : member.ownerHost)
      || member.kind === 'local' && route.origin !== null || member.kind === 'remote' && route.origin === null
  })) invalid('route-ownership')
  if (https.kind === 'disabled' && routes.some(route => route.origin !== null)) invalid('https-disabled-with-remote-route')
  if (subagents?.kind === 'enabled' && subagents.parents.some(parent => !members.some(member => member.kind === 'local' && member.agentKey === parent.agentKey && member.spec.protocolVersion === 2))) invalid('subagent-parent-reference')
  if (workflows?.kind === 'enabled') {
    const allIds = [...memberIds, ...workflows.definitions.flatMap(item => item.sessionId === null ? [] : [item.sessionId])]
    unique(allIds, 'sessionId')
    for (const entry of workflows.definitions) {
      const definition = entry.definition
      const roster = definition.roster as unknown as readonly { memberKey: string; address: string }[]
      for (const peer of roster) if (!members.some(member => member.kind === 'local' && member.agentKey === peer.memberKey
        && member.sessionId !== null && formatSessionAddress(parseSessionId(member.sessionId)) === peer.address)) invalid('workflow-roster-member')
    }
    if (workflows.maxInventorySessions < members.filter(member => member.kind === 'local').length + workflows.definitions.length) invalid('workflow-inventory-limit')
  }
  if (messages.some(message => message.type.startsWith('subagent/') || message.type.startsWith('workflow/'))) invalid('reserved-message-type')
  return snapshotJson({ schemaVersion: input.schemaVersion, ...(subagents === undefined ? {} : { subagents }),
    ...(workspaceResources === undefined ? {} : { workspaceResources }), ...(workflows === undefined ? {} : { workflows }),
    hostKey, storage: { root, maxRecordBytes: integer(storage.maxRecordBytes, 'maxRecordBytes', 4096),
    maxLineageDepth: integer(storage.maxLineageDepth, 'maxLineageDepth', 0) }, members, messages, channels, routes,
    https, communication, scheduling, cli, shutdown }) as unknown as HostConfig
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
    const rawFingerprint = text(peer.fingerprint256, 'https.fingerprint256', 95)
    if (!/^(?:[0-9a-fA-F]{64}|(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2})$/.test(rawFingerprint)) invalid('https-fingerprint')
    const fingerprint256 = rawFingerprint.replaceAll(':', '').toLowerCase()
    const sessionIds = array(peer.sessionIds, 'https.sessionIds').map(value => parseSessionId(text(value, 'https.sessionId')))
    unique(sessionIds, 'https-sessionId')
    return Object.freeze({ hostKey: identifier(peer.hostKey, 'https.peer.hostKey'), fingerprint256, sessionIds })
  })
  unique(peers.map(peer => `${peer.hostKey}\u0000${peer.fingerprint256}`), 'https-peer')
  unique(peers.map(peer => peer.fingerprint256), 'https-fingerprint')
  if (integer(listen.port, 'https.listen.port') > 65535) invalid('https-listen-port')
  const limits = decodeIntegerRecord(input.limits, ['maxHeaderBytes', 'maxBodyBytes', 'maxResponseBytes', 'maxConnections',
    'maxInFlightRequests', 'handshakeTimeoutMs', 'headersTimeoutMs', 'bodyTimeoutMs', 'requestTimeoutMs', 'idleTimeoutMs'], 'https.limits') as unknown as HttpsMessageLimits
  if (Object.entries(limits).some(([key, value]) => key.endsWith('Ms') && value > 2_147_483_647)) invalid('https-timeout-range')
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

function decodeMember(value: JsonValue, index: number, baseDirectory: string, version: 1 | 2 | 3): HostMemberConfig {
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
  const specVersion = record(member.spec, 'spec').protocolVersion
  if (specVersion !== 1 && specVersion !== 2 || version === 1 && specVersion !== 1) invalid('member-spec-version')
  const profile = specVersion === 1 ? decodeAgentContextProfile(member.profile) : decodeSubagentContextProfile(member.profile)
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
  const peerKeys: string[] = []
  for (const value of array(spec.peers, 'spec.peers')) {
    const peer = record(value, 'spec.peer')
    keys(peer, ['key', 'memberKey', 'channelKey'], 'spec.peer')
    peerKeys.push(identifier(peer.key, 'spec.peer.key'))
    identifier(peer.memberKey, 'spec.peer.memberKey'); identifier(peer.channelKey, 'spec.peer.channelKey')
  }
  unique(peerKeys, 'peer-key')
  for (const item of array(spec.messages, 'spec.messages')) {
    const message = record(item, 'spec.message')
    keys(message, ['type', 'payloadVersion', 'requiresReply'], 'spec.message')
    text(message.type, 'spec.message.type', 128); integer(message.payloadVersion, 'spec.message.payloadVersion')
    if (typeof message.requiresReply !== 'boolean') invalid('spec.message.requiresReply')
  }
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
  const workflows = config.schemaVersion === 3 && config.workflows.kind === 'enabled' ? {
    ...config.workflows, definitions: config.workflows.definitions.map(entry => {
      const sessionId = entry.sessionId ?? identities.nextSessionId()
      return { sessionId, definition: { ...entry.definition, coordinator: formatSessionAddress(parseSessionId(sessionId)) } }
    }),
  } : config.schemaVersion === 3 ? config.workflows : undefined
  return decodeHostConfig({ ...config, members, channels, ...(workflows === undefined ? {} : { workflows }) }, config.storage.root)
}

/** Resolve peer references and the exact Provider descriptor persisted in each AgentSpec. */
export function resolveHostConfig(config: HostConfig): ResolvedHostSpec {
  if (config.members.some(member => member.kind === 'local' && member.sessionId === null) || config.channels.some(channel => channel.channelId === null)) invalid('unplanned-identity')
  if (config.schemaVersion === 3 && config.workflows.kind === 'enabled'
    && config.workflows.definitions.some(entry => entry.sessionId === null)) invalid('unplanned-workflow-identity')
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
    const { profileEventId: _profileEventId, ...spec } = member.spec.protocolVersion === 1 ? decodeAgentSpec(provisional)
      : decodeSubagentAgentSpec({ ...provisional, subagents: parentSubagentRole(config.schemaVersion === 1 ? undefined : config.subagents, member.agentKey) })
    return Object.freeze({ ...member, sessionId: parseSessionId(member.sessionId!), spec })
  })
  const routes = config.routes.map(route => ({ ...route, sessionId: members.get(route.memberKey)!.sessionId! }))
  return snapshotJson({ ...config, members: resolved, routes,
    channels: config.channels.map(channel => ({ channelKey: channel.channelKey, channelId: channel.channelId! })) }) as unknown as ResolvedHostSpec
}

export function isLocalHostMember(member: ResolvedHostMember): member is ResolvedHostLocalMember {
  return member.kind === 'local'
}

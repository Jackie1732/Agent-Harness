import { dirname, resolve } from 'node:path'
import { boundedJson, parseBoundedJson } from '../schema/bounded-json.js'
import { HOST_CONFIG_LIMITS } from '../host/config.js'
import type { ResolvedHostSpec } from '../host/config.js'
import { HostError } from '../host/errors.js'
import { API_HTTP_STATUS, CONTROL_METHODS, CONTROL_PROTOCOL, CONTROL_VERSION } from '../protocol/index.js'
import type { ControlMethod } from '../protocol/index.js'

/** Static operation identity and independently granted member/workflow scopes. */
export interface ApiPrincipal {
  readonly principalKey: string
  readonly certificateFingerprints: readonly string[]
  readonly methods: readonly ControlMethod[]
  readonly agentKeys: readonly string[]
  readonly workflowKeys: readonly string[]
}
/** Deployment values for HTTP resources and independently admitted domain operations. */
export interface ApiLimits {
  readonly maxRequestBytes: number; readonly maxJsonDepth: number; readonly maxJsonNodes: number
  readonly maxHeaderBytes: number; readonly maxResponseBytes: number; readonly maxPageEvents: number
  readonly maxConnections: number; readonly maxPendingInputs: number; readonly maxPendingControls: number
  readonly maxObservers: number; readonly maxPendingShutdowns: number
  readonly requestReadTimeoutMs: number; readonly responseWriteTimeoutMs: number
  readonly tlsHandshakeTimeoutMs: number; readonly headersTimeoutMs: number; readonly keepAliveTimeoutMs: number
  readonly maxWaitMs: number; readonly observerScanIntervalMs: number
}
/** Closed, local-only v1 server configuration. Relative TLS paths belong to its file directory. */
export interface ApiConfig {
  readonly schemaVersion: 1
  readonly listenHost: string
  readonly listenPort: number
  readonly tls: { readonly caFile: string; readonly serverCertFile: string; readonly serverKeyFile: string }
  readonly principals: readonly ApiPrincipal[]
  readonly limits: ApiLimits
}
/** Resolved TLS files and protected configuration/material directories. */
export interface ResolvedApiConfig extends ApiConfig { readonly protectedRoots: readonly string[] }

const limitKeys = ['maxRequestBytes', 'maxJsonDepth', 'maxJsonNodes', 'maxHeaderBytes', 'maxResponseBytes', 'maxPageEvents',
  'maxConnections', 'maxPendingInputs', 'maxPendingControls', 'maxObservers', 'maxPendingShutdowns', 'requestReadTimeoutMs',
  'responseWriteTimeoutMs', 'tlsHandshakeTimeoutMs', 'headersTimeoutMs', 'keepAliveTimeoutMs', 'maxWaitMs', 'observerScanIntervalMs'] as const
function invalid(reason: string): never { throw new HostError('HOST_CONFIG_INVALID', `api-${reason}`) }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('object')
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== fields.length || fields.some(key => !Object.hasOwn(item, key))) invalid('fields')
  return item
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4096) invalid('text')
  return value
}
function list(value: unknown): string[] {
  if (!Array.isArray(value)) invalid('list')
  const result = value.map(text)
  if (new Set(result).size !== result.length) invalid('duplicate')
  return result
}
/** Decode all required fields and numeric relationships before any Host is acquired. */
export function decodeApiConfig(value: unknown): ApiConfig {
  const root = object(boundedJson(value, HOST_CONFIG_LIMITS), ['schemaVersion', 'listenHost', 'listenPort', 'tls', 'principals', 'limits'])
  if (root.schemaVersion !== 1) invalid('version')
  if (!Number.isSafeInteger(root.listenPort) || Number(root.listenPort) < 0 || Number(root.listenPort) > 65535) invalid('port')
  const tls = object(root.tls, ['caFile', 'serverCertFile', 'serverKeyFile'])
  const limits = object(root.limits, limitKeys)
  for (const key of limitKeys) {
    const item = limits[key]
    if (!Number.isSafeInteger(item) || Number(item) < 1 || key.endsWith('Ms') && Number(item) > 2147483647) invalid('limit')
  }
  if (Number(limits.maxJsonDepth) > 128) invalid('limit-relationship')
  const minimum = Math.max(...Object.keys(API_HTTP_STATUS).map(code => Buffer.byteLength(JSON.stringify({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: 'r'.repeat(128),
    kind: 'error', error: { code, message: 'Invalid control request', acceptance: 'not-applicable', domainCode: null } }))))
  if (Number(limits.maxResponseBytes) < minimum) invalid('response-budget')
  try { boundedJson({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: 'r'.repeat(128), kind: 'error',
    error: { code: 'API_PROTOCOL_INVALID', message: 'Invalid control request', acceptance: 'not-applicable', domainCode: null } },
    { maxBytes: Number(limits.maxResponseBytes), maxDepth: Number(limits.maxJsonDepth), maxNodes: Number(limits.maxJsonNodes) }) }
  catch { invalid('error-json-budget') }
  if (!Array.isArray(root.principals)) invalid('principals')
  const fingerprints = new Set<string>(), principalKeys = new Set<string>()
  const principals = root.principals.map(value => {
    const entry = object(value, ['principalKey', 'certificateFingerprints', 'methods', 'agentKeys', 'workflowKeys'])
    const principalKey = text(entry.principalKey)
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(principalKey) || principalKeys.has(principalKey)) invalid('principal-key')
    principalKeys.add(principalKey)
    const certificateFingerprints = list(entry.certificateFingerprints).map(value => value.replaceAll(':', '').toLowerCase())
    if (certificateFingerprints.length === 0) invalid('fingerprints')
    for (const fingerprint of certificateFingerprints) {
      if (!/^[a-f0-9]{64}$/.test(fingerprint) || fingerprints.has(fingerprint)) invalid('fingerprint')
      fingerprints.add(fingerprint)
    }
    const methods = list(entry.methods)
    if (methods.some(method => !(CONTROL_METHODS as readonly string[]).includes(method))) invalid('method')
    return Object.freeze({ principalKey, certificateFingerprints: Object.freeze(certificateFingerprints),
      methods: Object.freeze(methods as ControlMethod[]), agentKeys: Object.freeze(list(entry.agentKeys)), workflowKeys: Object.freeze(list(entry.workflowKeys)) })
  })
  return Object.freeze({ schemaVersion: 1, listenHost: text(root.listenHost), listenPort: Number(root.listenPort),
    tls: Object.freeze({ caFile: text(tls.caFile), serverCertFile: text(tls.serverCertFile), serverKeyFile: text(tls.serverKeyFile) }),
    principals: Object.freeze(principals), limits: Object.freeze(limits as unknown as ApiLimits) })
}
/** Parse bounded UTF-8 JSON configuration without opening resources. */
export function parseApiConfig(textValue: string): ApiConfig { return decodeApiConfig(parseBoundedJson(textValue, HOST_CONFIG_LIMITS)) }
/** Resolve local files and verify configured grants against a fixed Host recipe. */
export function resolveApiConfig(config: ApiConfig, host: ResolvedHostSpec, baseDirectory: string): ResolvedApiConfig {
  const workflows = host.schemaVersion === 3 && host.workflows.kind === 'enabled' ? host.workflows.definitions.map(entry => entry.definition) : []
  for (const principal of config.principals) {
    if (principal.agentKeys.some(key => !host.members.some(member => member.kind === 'local' && member.agentKey === key))
      || principal.workflowKeys.some(key => !workflows.some(definition => definition.workflowKey === key))) invalid('grant-target')
    if (principal.methods.includes('agent.pause') || principal.methods.includes('agent.resume')) {
      for (const key of principal.agentKeys) if (workflows.some(definition => definition.roster.some(member => member.memberKey === key)
        && !principal.workflowKeys.includes(definition.workflowKey))) invalid('member-workflow-grant')
    }
  }
  const tls = { caFile: resolve(baseDirectory, config.tls.caFile), serverCertFile: resolve(baseDirectory, config.tls.serverCertFile),
    serverKeyFile: resolve(baseDirectory, config.tls.serverKeyFile) }
  return Object.freeze({ ...config, tls: Object.freeze(tls), protectedRoots: Object.freeze([...new Set([resolve(baseDirectory), ...Object.values(tls).map(dirname)])]) })
}

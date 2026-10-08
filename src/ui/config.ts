import { resolve } from 'node:path'
import { boundedJson, parseBoundedJson } from '../schema/bounded-json.js'
import { HOST_CONFIG_LIMITS } from '../host/config.js'
import { HostError } from '../host/errors.js'
import { resolveClientOptions } from '../client/config.js'
import type { ClientLimits } from '../client/config.js'

/** Loopback HTTP admission, browser session and output deadlines. */
export interface UiLimits {
  readonly maxRequestBytes: number; readonly maxJsonDepth: number; readonly maxJsonNodes: number
  readonly maxHeaderBytes: number; readonly maxConnections: number; readonly maxPendingRequests: number
  readonly requestReadTimeoutMs: number; readonly responseWriteTimeoutMs: number
  readonly headersTimeoutMs: number; readonly keepAliveTimeoutMs: number; readonly sessionTimeoutMs: number
}
/** Static remote connection and display scopes; the remote API owns authorization. */
export interface UiConfig {
  readonly schemaVersion: 1
  readonly listenPort: number
  readonly remote: { readonly origin: string; readonly serverName: string | null
    readonly caFile: string; readonly certFile: string; readonly keyFile: string; readonly limits: ClientLimits }
  readonly passwordEnv: string
  readonly memberKeys: readonly string[]
  readonly workflowKeys: readonly string[]
  readonly limits: UiLimits
}
/** TLS file names resolved against the local configuration directory. */
export type ResolvedUiConfig = UiConfig
const httpKeys = ['maxRequestBytes', 'maxJsonDepth', 'maxJsonNodes', 'maxHeaderBytes', 'maxConnections', 'maxPendingRequests',
  'requestReadTimeoutMs', 'responseWriteTimeoutMs', 'headersTimeoutMs', 'keepAliveTimeoutMs', 'sessionTimeoutMs'] as const
const clientKeys = ['maxRequestBytes', 'maxResponseBytes', 'maxJsonDepth', 'maxJsonNodes', 'connectTimeoutMs', 'requestTimeoutMs', 'maxConnections'] as const
function invalid(reason: string): never { throw new HostError('HOST_CONFIG_INVALID', `ui-${reason}`) }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('object')
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) invalid('fields')
  return item
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4096) invalid('text')
  return value
}
function keys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) invalid('keys')
  const result = value.map(text)
  if (new Set(result).size !== result.length) invalid('duplicate-key')
  return Object.freeze(result)
}
/** Validate all browser and SDK budgets before acquiring a listener or client. */
export function decodeUiConfig(value: unknown): UiConfig {
  const root = object(boundedJson(value, HOST_CONFIG_LIMITS), ['schemaVersion', 'listenPort', 'remote', 'passwordEnv', 'memberKeys', 'workflowKeys', 'limits'])
  if (root.schemaVersion !== 1) invalid('version')
  if (!Number.isSafeInteger(root.listenPort) || Number(root.listenPort) < 0 || Number(root.listenPort) > 65535) invalid('port')
  const remote = object(root.remote, ['origin', 'serverName', 'caFile', 'certFile', 'keyFile', 'limits'])
  const limits = object(root.limits, httpKeys), client = object(remote.limits, clientKeys)
  for (const collection of [limits, client]) for (const [key, value] of Object.entries(collection)) {
    if (!Number.isSafeInteger(value) || Number(value) < 1 || key.endsWith('Ms') && Number(value) > 2147483647) invalid('limit')
  }
  if (Number(limits.maxJsonDepth) > 128 || Number(client.maxJsonDepth) > 128) invalid('json-depth')
  const passwordEnv = text(root.passwordEnv)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordEnv)) invalid('password-env')
  const origin = text(remote.origin), serverName = remote.serverName === null ? null : text(remote.serverName)
  try { resolveClientOptions({ origin, ...(serverName === null ? {} : { serverName }), tls: { ca: 'configuration-only', cert: 'configuration-only', key: 'configuration-only' }, limits: client as unknown as ClientLimits }) }
  catch { invalid('remote') }
  const config: UiConfig = { schemaVersion: 1, listenPort: Number(root.listenPort), passwordEnv,
    memberKeys: keys(root.memberKeys), workflowKeys: keys(root.workflowKeys), limits: Object.freeze(limits as unknown as UiLimits),
    remote: Object.freeze({ origin, serverName, caFile: text(remote.caFile), certFile: text(remote.certFile), keyFile: text(remote.keyFile), limits: Object.freeze(client as unknown as ClientLimits) }) }
  try { for (const output of [{ authenticated: true, connection: { origin, memberKeys: config.memberKeys, workflowKeys: config.workflowKeys, drive: 'explicit-run' } },
    { kind: 'error', error: { code: 'UI_CAPACITY_EXCEEDED', message: 'Browser gateway failed', acceptance: 'not-applicable', domainCode: null } }]) boundedJson(output,
    { maxBytes: config.remote.limits.maxResponseBytes, maxDepth: config.remote.limits.maxJsonDepth, maxNodes: config.remote.limits.maxJsonNodes }) }
  catch { invalid('session-response-budget') }
  return Object.freeze(config)
}
/** Parse bounded local JSON; secrets belong to the named environment variable. */
export function parseUiConfig(value: string): UiConfig { return decodeUiConfig(parseBoundedJson(value, HOST_CONFIG_LIMITS)) }
/** Resolve only local TLS files, without reading them or changing the remote origin. */
export function resolveUiConfig(config: UiConfig, baseDirectory: string): ResolvedUiConfig {
  return Object.freeze({ ...config, remote: Object.freeze({ ...config.remote,
    caFile: resolve(baseDirectory, config.remote.caFile), certFile: resolve(baseDirectory, config.remote.certFile), keyFile: resolve(baseDirectory, config.remote.keyFile) }) })
}

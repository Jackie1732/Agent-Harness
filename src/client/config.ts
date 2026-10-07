import type { SecureContextOptions } from 'node:tls'
import { isIP } from 'node:net'

/** Explicit request, response, JSON and connection budgets for one Node client. */
export interface ClientLimits {
  readonly maxRequestBytes: number; readonly maxResponseBytes: number; readonly maxJsonDepth: number; readonly maxJsonNodes: number
  readonly connectTimeoutMs: number; readonly requestTimeoutMs: number; readonly maxConnections: number
}
/** PEM material is supplied by the caller; the client reads no configuration or Store files. */
export interface HarnessClientOptions {
  readonly origin: string
  readonly serverName?: string
  readonly tls: { readonly ca: string | Buffer; readonly cert: string | Buffer; readonly key: string | Buffer }
  readonly limits: ClientLimits
}
/** Normalize one HTTPS origin and certificate name before any network operation. */
export function resolveClientOptions(options: HarnessClientOptions) {
  const origin = new URL(options.origin)
  if (origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '' || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    throw new TypeError('Client origin must be a HTTPS origin')
  }
  const required: readonly (keyof ClientLimits)[] = ['maxRequestBytes', 'maxResponseBytes', 'maxJsonDepth', 'maxJsonNodes', 'connectTimeoutMs', 'requestTimeoutMs', 'maxConnections']
  if (Object.keys(options.limits).length !== required.length || required.some(key => !Object.hasOwn(options.limits, key))) throw new TypeError('Client limits must be explicit')
  for (const key of required) {
    const value = options.limits[key]
    if (!Number.isSafeInteger(value) || value < 1 || key.endsWith('Ms') && value > 2147483647) throw new TypeError('Client limits are invalid')
  }
  if (options.limits.maxJsonDepth > 128) throw new TypeError('Client JSON depth exceeds protocol ceiling')
  for (const material of Object.values(options.tls)) if (!(typeof material === 'string' || Buffer.isBuffer(material)) || material.length === 0) throw new TypeError('Client TLS material is required')
  if (options.serverName !== undefined && (options.serverName.length === 0 || isIP(options.serverName) !== 0)) throw new TypeError('Explicit serverName must name a certificate DNS identity')
  const servername = options.serverName ?? (isIP(origin.hostname.replace(/^\[|\]$/g, '')) === 0 ? origin.hostname : '')
  return { origin, servername, tls: options.tls as Pick<SecureContextOptions, 'ca' | 'cert' | 'key'>, limits: Object.freeze({ ...options.limits }) }
}

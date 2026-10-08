import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { boundedJson, parseBoundedJson, inspectBoundedJson } from '../schema/bounded-json.js'
import { decodeParams, CONTROL_PROTOCOL, CONTROL_VERSION } from '../protocol/index.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { parseSessionId } from '../session/ids.js'
import { resolveClientOptions } from '../client/config.js'
import { isCanonicalIsoTimestamp } from '../foundation/protocol-scalars.js'
import { AutomationError, integer, key, record, text } from './validation.js'
import type { AutomationConfig, AutomationJob, AutomationLimits } from './config-types.js'
import type { ClientLimits } from '../client/config.js'

export const AUTOMATION_CONFIG_LIMITS = Object.freeze({ maxBytes: 1048576, maxDepth: 16, maxNodes: 10000 })
const resourceKeys = ['maxRequestBytes', 'maxResponseBytes', 'maxJsonDepth', 'maxJsonNodes', 'maxHeaderBytes', 'maxConnections', 'maxPendingRequests', 'maxQueued',
  'requestReadTimeoutMs', 'responseWriteTimeoutMs', 'headersTimeoutMs', 'tlsHandshakeTimeoutMs', 'keepAliveTimeoutMs', 'observeIntervalMs'] as const
const clientKeys = ['maxRequestBytes', 'maxResponseBytes', 'maxJsonDepth', 'maxJsonNodes', 'connectTimeoutMs', 'requestTimeoutMs', 'maxConnections'] as const
/** Decode every deployment field before acquiring a resource. */
export function decodeAutomationConfig(value: unknown): AutomationConfig {
  const root = record(boundedJson(value, AUTOMATION_CONFIG_LIMITS), ['schemaVersion', 'automationKey', 'hostKey', 'journal', 'client', 'webhook', 'limits', 'jobs'])
  if (root.schemaVersion !== 1) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  const journal = record(root.journal, ['root', 'sessionId', 'maxRecordBytes', 'maxTriggers', 'maxEvents'])
  const client = record(root.client, ['origin', 'serverName', 'tls', 'limits']), clientTls = record(client.tls, ['caFile', 'certFile', 'keyFile'])
  const clientBudget = record(client.limits, clientKeys), limits = record(root.limits, resourceKeys)
  for (const [fields, values] of [[clientKeys, clientBudget], [resourceKeys, limits]] as const) {
    for (const field of fields) integer(values[field], 1, field.endsWith('Ms') ? 2147483647 : Number.MAX_SAFE_INTEGER)
  }
  if (Number(limits.maxJsonDepth) > 128 || Number(limits.maxResponseBytes) < 1024) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  const webhook = record(root.webhook, ['listenHost', 'listenPort', 'tls', 'bearerTokenEnv']), webhookTls = record(webhook.tls, ['certFile', 'keyFile'])
  const origin = text(client.origin), serverName = client.serverName === null ? null : text(client.serverName)
  resolveClientOptions({ origin, ...(serverName === null ? {} : { serverName }), tls: { ca: 'validation', cert: 'validation', key: 'validation' }, limits: clientBudget as unknown as ClientLimits })
  const bearerTokenEnv = text(webhook.bearerTokenEnv, 128)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnv) || !Array.isArray(root.jobs) || root.jobs.length === 0 || root.jobs.length > 1000) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  const jobs: AutomationJob[] = root.jobs.map(value => {
    const job = record(value, ['jobKey', 'agentKey', 'trigger'])
    const raw = job.trigger as { kind?: unknown } | null
    const trigger = record(raw, raw?.kind === 'webhook' ? ['kind'] : ['kind', 'anchor', 'intervalMs', 'text'])
    if (trigger.kind === 'webhook') return { jobKey: key(job.jobKey), agentKey: text(job.agentKey, 128), trigger: { kind: 'webhook' } }
    if (trigger.kind !== 'interval' || !isCanonicalIsoTimestamp(text(trigger.anchor, 32))) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
    return { jobKey: key(job.jobKey), agentKey: text(job.agentKey, 128), trigger: { kind: 'interval', anchor: trigger.anchor as string,
      intervalMs: integer(trigger.intervalMs, 1, 2147483647), text: text(trigger.text, Number(limits.maxRequestBytes)) } }
  })
  if (new Set(jobs.map(job => job.jobKey)).size !== jobs.length) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  for (const job of jobs) if (job.trigger.kind === 'interval') {
    const budgets = { maxBytes: Number(clientBudget.maxRequestBytes), maxDepth: Number(clientBudget.maxJsonDepth), maxNodes: Number(clientBudget.maxJsonNodes) }
    const params = decodeParams('input.submit', { agentKey: job.agentKey, submissionKey: '0'.repeat(64), text: job.trigger.text }, budgets)
    inspectBoundedJson({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: '0'.repeat(36), method: 'input.submit', params }, budgets)
  }
  const maxRecordBytes = integer(journal.maxRecordBytes), maxTriggers = integer(journal.maxTriggers), maxEvents = integer(journal.maxEvents)
  if (maxRecordBytes < Number(limits.maxRequestBytes) + Number(clientBudget.maxResponseBytes) + 4096 || maxEvents < maxTriggers * 6 + 1) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  return Object.freeze({ schemaVersion: 1, automationKey: key(root.automationKey), hostKey: text(root.hostKey, 128),
    journal: Object.freeze({ root: text(journal.root), sessionId: parseSessionId(text(journal.sessionId)), maxRecordBytes, maxTriggers, maxEvents }),
    client: Object.freeze({ origin, serverName, tls: Object.freeze({ caFile: text(clientTls.caFile), certFile: text(clientTls.certFile), keyFile: text(clientTls.keyFile) }), limits: Object.freeze(clientBudget as unknown as ClientLimits) }),
    webhook: Object.freeze({ listenHost: text(webhook.listenHost), listenPort: integer(webhook.listenPort, 0, 65535),
      tls: Object.freeze({ certFile: text(webhookTls.certFile), keyFile: text(webhookTls.keyFile) }), bearerTokenEnv }),
    limits: Object.freeze(limits as unknown as AutomationLimits), jobs: Object.freeze(jobs.map(job => Object.freeze({ ...job, trigger: Object.freeze(job.trigger) }))) })
}
/** Parse bounded JSON; relative paths are resolved separately against this file. */
export function parseAutomationConfig(value: string): AutomationConfig { return decodeAutomationConfig(parseBoundedJson(value, AUTOMATION_CONFIG_LIMITS)) }
/** Resolve only local files; remote callers cannot supply any of these values. */
export function resolveAutomationConfig(config: AutomationConfig, baseDirectory: string): AutomationConfig {
  return Object.freeze({ ...config, journal: Object.freeze({ ...config.journal, root: resolve(baseDirectory, config.journal.root) }),
    client: Object.freeze({ ...config.client, tls: Object.freeze({ caFile: resolve(baseDirectory, config.client.tls.caFile), certFile: resolve(baseDirectory, config.client.tls.certFile), keyFile: resolve(baseDirectory, config.client.tls.keyFile) }) }),
    webhook: Object.freeze({ ...config.webhook, tls: Object.freeze({ certFile: resolve(baseDirectory, config.webhook.tls.certFile), keyFile: resolve(baseDirectory, config.webhook.tls.keyFile) }) }) })
}
/** Fix all Job identities, targets and deployment values to one Automation Session. */
export function automationConfigDigest(config: AutomationConfig): string {
  return createHash('sha256').update(canonicalJsonBytes(config as unknown as import('../foundation/json.js').JsonObject)).digest('hex')
}

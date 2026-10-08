import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ClientLimits } from '../client/config.js'
import { resolveClientOptions } from '../client/config.js'
import type { SessionId } from '../session/ids.js'
import { parseSessionId } from '../session/ids.js'
import type { JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { isCanonicalUuid } from '../foundation/protocol-scalars.js'
import { boundedJson, parseBoundedJson } from '../schema/bounded-json.js'
import { HostError } from '../host/errors.js'
import { readConfigFile } from './config-files.js'

/** Terminal deployment selections; values contain references rather than secret material. */
export interface OperatorProfile {
  readonly schemaVersion: 1
  readonly profileKey: string
  readonly connection: { readonly kind: 'local'; readonly hostConfig: string; readonly shutdownMode: 'drain' | 'cancel' }
    | { readonly kind: 'remote'; readonly origin: string; readonly serverName: string | null;
      readonly tlsFiles: { readonly ca: string; readonly cert: string; readonly key: string }; readonly limits: ClientLimits;
      readonly targets: { readonly agentKeys: readonly string[]; readonly workflowKeys: readonly string[] } }
  readonly files: { readonly api: string | null; readonly ui: string | null; readonly automation: string | null; readonly experiment: string | null }
  readonly journal: { readonly root: string; readonly sessionId: SessionId; readonly maxRecordBytes: number; readonly maxIntents: number; readonly maxEvents: number }
  readonly observation: { readonly maxWaitMs: number; readonly scanIntervalMs: number; readonly pollIntervalMs: number;
    readonly maxObservers: number; readonly maxPageEvents: number; readonly maxPageBytes: number; readonly maxBufferedEvents: number; readonly maxBufferedBytes: number }
  readonly display: { readonly locale: 'zh-CN'; readonly maxTextBytes: number }
  readonly output: { readonly maxBytes: number; readonly drainTimeoutMs: number }
}
/** Paths belong to the profile's directory; only local profiles define a submission caller. */
export interface ResolvedOperatorProfile extends OperatorProfile {
  readonly profilePath: string
  readonly directory: string
  readonly callerNamespace: string | null
}
export const OPERATOR_PROFILE_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDepth: 32, maxNodes: 10000 })
function invalid(reason: string): never { throw new HostError('HOST_CONFIG_INVALID', `operator-${reason}`) }
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
function filePath(value: unknown): string {
  const path = text(value)
  if (/[\u0000-\u001f\u007f]/.test(path)) invalid('file-path')
  return path
}
function integers(value: unknown, keys: readonly string[]): Record<string, number> {
  const result = object(value, keys)
  for (const key of keys) if (!Number.isSafeInteger(result[key]) || Number(result[key]) < 1
    || key.endsWith('Ms') && Number(result[key]) > 2147483647) invalid('limit')
  return result as Record<string, number>
}
function list(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) invalid('targets')
  const result = value.map(text)
  if (new Set(result).size !== result.length) invalid('duplicate-target')
  return result
}
/** Decode all profile fields without reading files or opening a client. */
export function decodeOperatorProfile(value: unknown): OperatorProfile {
  const root = object(boundedJson(value, OPERATOR_PROFILE_LIMITS), ['schemaVersion', 'profileKey', 'connection', 'files', 'journal', 'observation', 'display', 'output'])
  if (root.schemaVersion !== 1 || typeof root.profileKey !== 'string' || !isCanonicalUuid(root.profileKey)) invalid('identity')
  const rawConnection = root.connection as { kind?: unknown } | null
  let connection: OperatorProfile['connection']
  if (rawConnection?.kind === 'local') {
    const local = object(rawConnection, ['kind', 'hostConfig', 'shutdownMode'])
    if (local.shutdownMode !== 'drain' && local.shutdownMode !== 'cancel') invalid('shutdown-mode')
    connection = { kind: 'local', hostConfig: filePath(local.hostConfig), shutdownMode: local.shutdownMode }
  } else {
    const remote = object(rawConnection, ['kind', 'origin', 'serverName', 'tlsFiles', 'limits', 'targets'])
    if (remote.kind !== 'remote') invalid('connection-kind')
    const tls = object(remote.tlsFiles, ['ca', 'cert', 'key']), targets = object(remote.targets, ['agentKeys', 'workflowKeys'])
    const limits = integers(remote.limits, ['maxRequestBytes', 'maxResponseBytes', 'maxJsonDepth', 'maxJsonNodes', 'connectTimeoutMs', 'requestTimeoutMs', 'maxConnections']) as unknown as ClientLimits
    const origin = text(remote.origin), serverName = remote.serverName === null ? null : text(remote.serverName)
    const validated = resolveClientOptions({ origin, ...(serverName === null ? {} : { serverName }),
      tls: { ca: 'configuration-only', cert: 'configuration-only', key: 'configuration-only' }, limits })
    connection = { kind: 'remote', origin: validated.origin.origin, serverName,
      tlsFiles: { ca: filePath(tls.ca), cert: filePath(tls.cert), key: filePath(tls.key) }, limits,
      targets: { agentKeys: list(targets.agentKeys), workflowKeys: list(targets.workflowKeys) } }
  }
  const files = object(root.files, ['api', 'ui', 'automation', 'experiment'])
  const journal = object(root.journal, ['root', 'sessionId', 'maxRecordBytes', 'maxIntents', 'maxEvents'])
  const journalLimits = integers({ maxRecordBytes: journal.maxRecordBytes, maxIntents: journal.maxIntents, maxEvents: journal.maxEvents }, ['maxRecordBytes', 'maxIntents', 'maxEvents'])
  if (journalLimits.maxRecordBytes! < 32768 || journalLimits.maxEvents! < journalLimits.maxIntents! * 2 + 1) invalid('journal-budget')
  const observation = integers(root.observation, ['maxWaitMs', 'scanIntervalMs', 'pollIntervalMs', 'maxObservers', 'maxPageEvents', 'maxPageBytes', 'maxBufferedEvents', 'maxBufferedBytes'])
  const display = object(root.display, ['locale', 'maxTextBytes'])
  if (display.locale !== 'zh-CN') invalid('locale')
  integers({ maxTextBytes: display.maxTextBytes }, ['maxTextBytes'])
  const output = integers(root.output, ['maxBytes', 'drainTimeoutMs'])
  return snapshotJson({ schemaVersion: 1, profileKey: root.profileKey, connection,
    files: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, value === null ? null : filePath(value)])),
    journal: { root: filePath(journal.root), sessionId: parseSessionId(text(journal.sessionId)), ...journalLimits }, observation, display, output } as unknown as JsonValue) as unknown as OperatorProfile
}
/** Parse bounded UTF-8 profile JSON. */
export function parseOperatorProfile(source: string): OperatorProfile { return decodeOperatorProfile(parseBoundedJson(source, OPERATOR_PROFILE_LIMITS)) }
/** Resolve references once against the selected profile file. */
export function resolveOperatorProfile(profile: OperatorProfile, profilePath: string): ResolvedOperatorProfile {
  const path = resolve(profilePath), directory = dirname(path)
  const connection = profile.connection.kind === 'local' ? { ...profile.connection, hostConfig: resolve(directory, profile.connection.hostConfig) }
    : { ...profile.connection, tlsFiles: { ca: resolve(directory, profile.connection.tlsFiles.ca), cert: resolve(directory, profile.connection.tlsFiles.cert), key: resolve(directory, profile.connection.tlsFiles.key) } }
  return Object.freeze({ ...profile, connection: Object.freeze(connection),
    files: Object.freeze(Object.fromEntries(Object.entries(profile.files).map(([key, value]) => [key, value === null ? null : resolve(directory, value)]))) as OperatorProfile['files'],
    journal: Object.freeze({ ...profile.journal, root: resolve(directory, profile.journal.root) }), profilePath: path, directory,
    callerNamespace: profile.connection.kind === 'local' ? `local:${profile.profileKey}` : null })
}
/** Read one selected profile and capture the byte revision used by later edits. */
export async function readOperatorProfile(path: string) {
  const file = await readConfigFile(path, OPERATOR_PROFILE_LIMITS)
  return { ...file, profile: resolveOperatorProfile(decodeOperatorProfile(file.value), file.path) }
}
/** Fields that identify the journal's deployment and authentication references; preferences and budgets are independent. */
export function operatorProfileBinding(profile: ResolvedOperatorProfile): JsonValue {
  return { profileKey: profile.profileKey, journal: { root: profile.journal.root, sessionId: profile.journal.sessionId },
    connection: profile.connection.kind === 'local' ? { kind: 'local', hostConfig: profile.connection.hostConfig }
      : { kind: 'remote', origin: profile.connection.origin, serverName: profile.connection.serverName, tlsFiles: profile.connection.tlsFiles } }
}
/** Establish editable template budgets and independently allocated terminal identities. */
export function buildOperatorProfile(connection: OperatorProfile['connection'], files: OperatorProfile['files'] = { api: null, ui: null, automation: null, experiment: null }): OperatorProfile {
  return decodeOperatorProfile({ schemaVersion: 1, profileKey: randomUUID(), connection, files,
    journal: { root: './operator-journal', sessionId: randomUUID(), maxRecordBytes: 8 * 1024 * 1024, maxIntents: 10000, maxEvents: 50000 },
    observation: { maxWaitMs: 30000, scanIntervalMs: 250, pollIntervalMs: 1000, maxObservers: 4, maxPageEvents: 64, maxPageBytes: 1048576, maxBufferedEvents: 512, maxBufferedBytes: 2097152 },
    display: { locale: 'zh-CN', maxTextBytes: 65536 }, output: { maxBytes: 4194304, drainTimeoutMs: 5000 } })
}

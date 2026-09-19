import { createHash } from 'node:crypto'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { parseSessionEventId, sessionLogPosition } from '../session/ids.js'
import type { SessionEventId, SessionLogPosition } from '../session/ids.js'
import { HostError } from './errors.js'

export interface HostSessionPlanned extends JsonObject {
  readonly hostKey: string
  readonly agentKey: string
  readonly recipe: JsonObject
  readonly fingerprint: string
}
export interface HostSessionReady extends JsonObject {
  readonly hostKey: string
  readonly agentKey: string
  readonly mode: 'initialized' | 'adopted'
  readonly planned: SessionEventId | null
  readonly profile: SessionEventId
  readonly spec: SessionEventId
  readonly through: SessionLogPosition
}

function invalid(reason: string): never { throw new HostError('HOST_BINDING_CONFLICT', reason) }
function object(value: unknown): Record<string, JsonValue> {
  const copy = snapshotJson(value)
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) invalid('host-event-object')
  return copy as Record<string, JsonValue>
}
function exact(value: Record<string, JsonValue>, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) invalid('host-event-fields')
}
function shortText(value: JsonValue, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 128) invalid(label)
  return value
}

export function fingerprintHostRecipe(recipe: JsonObject): string {
  return createHash('sha256').update(canonicalJsonBytes(recipe)).digest('hex')
}
function decodePlanned(value: JsonValue): HostSessionPlanned {
  const input = object(value); exact(input, ['hostKey', 'agentKey', 'recipe', 'fingerprint'])
  const recipe = object(input.recipe!)
  const fingerprint = shortText(input.fingerprint!, 'planned-fingerprint')
  if (!/^[0-9a-f]{64}$/.test(fingerprint) || fingerprintHostRecipe(recipe) !== fingerprint) invalid('planned-fingerprint')
  return Object.freeze({ hostKey: shortText(input.hostKey!, 'planned-host'), agentKey: shortText(input.agentKey!, 'planned-agent'), recipe, fingerprint })
}
function eventId(value: JsonValue, label: string): SessionEventId {
  if (typeof value !== 'string') invalid(label)
  parseSessionEventId(value)
  return value as SessionEventId
}
function decodeReady(value: JsonValue): HostSessionReady {
  const input = object(value); exact(input, ['hostKey', 'agentKey', 'mode', 'planned', 'profile', 'spec', 'through'])
  if (input.mode !== 'initialized' && input.mode !== 'adopted') invalid('ready-mode')
  const planned = input.planned === null ? null : eventId(input.planned!, 'ready-planned')
  if (input.mode === 'initialized' !== (planned !== null)) invalid('ready-planned-mode')
  return Object.freeze({ hostKey: shortText(input.hostKey!, 'ready-host'), agentKey: shortText(input.agentKey!, 'ready-agent'), mode: input.mode,
    planned, profile: eventId(input.profile!, 'ready-profile'), spec: eventId(input.spec!, 'ready-spec'), through: sessionLogPosition(input.through as number) })
}

export const hostSessionPlannedEvent = createDurableEventDefinition({
  type: 'host/session-planned', payloadVersion: 1, ignorable: false, decode: decodePlanned,
})
export const hostSessionReadyEvent = createDurableEventDefinition({
  type: 'host/session-ready', payloadVersion: 1, ignorable: false, decode: decodeReady,
})
export const hostSessionEventDefinitions = Object.freeze([hostSessionPlannedEvent, hostSessionReadyEvent])

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
export interface HostAgentPlannedV2 extends HostSessionPlanned { readonly kind: 'agent' }
export interface HostAgentReadyV2 extends HostSessionReady { readonly kind: 'agent' }

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

/** A coordinator has a complete fixed recipe and no AgentSpec or Model Provider. */
export interface HostWorkflowPlanned extends JsonObject {
  readonly hostKey: string
  readonly kind: 'workflow'
  readonly workflowKey: string
  readonly recipe: JsonObject
  readonly fingerprint: string
}
export interface HostWorkflowReady extends JsonObject {
  readonly hostKey: string
  readonly kind: 'workflow'
  readonly workflowKey: string
  readonly mode: 'initialized'
  readonly planned: SessionEventId
  readonly definition: SessionEventId
  readonly through: SessionLogPosition
}
function decodeWorkflowPlanned(value: JsonValue): HostWorkflowPlanned {
  const input = object(value); exact(input, ['hostKey', 'kind', 'workflowKey', 'recipe', 'fingerprint'])
  if (input.kind !== 'workflow') invalid('planned-workflow-kind')
  const recipe = object(input.recipe!)
  const fingerprint = shortText(input.fingerprint!, 'planned-workflow-fingerprint')
  if (!/^[0-9a-f]{64}$/.test(fingerprint) || fingerprintHostRecipe(recipe) !== fingerprint) invalid('planned-workflow-fingerprint')
  return Object.freeze({ hostKey: shortText(input.hostKey!, 'planned-host'), kind: 'workflow',
    workflowKey: shortText(input.workflowKey!, 'planned-workflow'), recipe, fingerprint })
}
function decodeWorkflowReady(value: JsonValue): HostWorkflowReady {
  const input = object(value); exact(input, ['hostKey', 'kind', 'workflowKey', 'mode', 'planned', 'definition', 'through'])
  if (input.kind !== 'workflow' || input.mode !== 'initialized') invalid('ready-workflow-kind')
  return Object.freeze({ hostKey: shortText(input.hostKey!, 'ready-host'), kind: 'workflow',
    workflowKey: shortText(input.workflowKey!, 'ready-workflow'), mode: 'initialized',
    planned: eventId(input.planned!, 'ready-planned'), definition: eventId(input.definition!, 'ready-definition'),
    through: sessionLogPosition(input.through as number) })
}
function decodePlannedV2(value: JsonValue): HostAgentPlannedV2 | HostWorkflowPlanned {
  const input = object(value)
  if (input.kind !== 'agent') return decodeWorkflowPlanned(value)
  exact(input, ['hostKey', 'kind', 'agentKey', 'recipe', 'fingerprint'])
  return Object.freeze({ ...decodePlanned({ hostKey: input.hostKey!, agentKey: input.agentKey!,
    recipe: input.recipe!, fingerprint: input.fingerprint! }), kind: 'agent' })
}
function decodeReadyV2(value: JsonValue): HostAgentReadyV2 | HostWorkflowReady {
  const input = object(value)
  if (input.kind !== 'agent') return decodeWorkflowReady(value)
  exact(input, ['hostKey', 'kind', 'agentKey', 'mode', 'planned', 'profile', 'spec', 'through'])
  return Object.freeze({ ...decodeReady({ hostKey: input.hostKey!, agentKey: input.agentKey!, mode: input.mode!,
    planned: input.planned!, profile: input.profile!, spec: input.spec!, through: input.through! }), kind: 'agent' })
}
export const hostSessionPlannedV2Event = createDurableEventDefinition<HostAgentPlannedV2 | HostWorkflowPlanned>({
  type: 'host/session-planned', payloadVersion: 2, ignorable: false, decode: decodePlannedV2,
})
export const hostSessionReadyV2Event = createDurableEventDefinition<HostAgentReadyV2 | HostWorkflowReady>({
  type: 'host/session-ready', payloadVersion: 2, ignorable: false, decode: decodeReadyV2,
})
export const hostSessionEventDefinitions = Object.freeze([
  hostSessionPlannedEvent, hostSessionReadyEvent, hostSessionPlannedV2Event, hostSessionReadyV2Event,
])

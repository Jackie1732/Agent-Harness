import { snapshotJson } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'
import { SessionError } from './errors.js'
import type { SessionEndedPayload } from './types.js'

/** Runtime definition of one durable event payload version. */
export interface DurableEventDefinition<TPayload extends JsonValue = JsonValue> {
  readonly type: string
  readonly payloadVersion: number
  readonly ignorable: boolean
  /** Decode and validate one JSON payload. */
  readonly decode: (value: JsonValue) => TPayload
}

/** Immutable set of event definitions accepted by one Session Repository. */
export interface DurableEventCatalog {
  /** Resolve one exact event type and payload version. */
  resolve(type: string, payloadVersion: number): DurableEventDefinition | undefined
  /** Check whether this Catalog contains the exact definition object. */
  contains(definition: DurableEventDefinition): boolean
}

/** Construction fields for one frozen durable event definition. */
export interface DurableEventDefinitionOptions<TPayload extends JsonValue> {
  readonly type: string
  readonly payloadVersion: number
  readonly ignorable: boolean
  readonly decode: (value: JsonValue) => TPayload
}

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/
const MAX_EVENT_TYPE_LENGTH = 128

/** Require a canonical durable event type. */
export function validateDurableEventType(type: string): string {
  if (type.length > MAX_EVENT_TYPE_LENGTH || !EVENT_TYPE_PATTERN.test(type)) {
    throw new SessionError('SESSION_EVENT_INVALID', 'durable event type is not canonical', {
      details: { type },
    })
  }
  return type
}

/** Require a positive safe payload version. */
export function validatePayloadVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new SessionError('SESSION_EVENT_INVALID', 'payload version must be a positive safe integer', {
      details: { payloadVersion: version },
    })
  }
  return version
}

function definitionKey(type: string, payloadVersion: number): string {
  return `${type}\u0000${payloadVersion}`
}

function validateDefinition(definition: DurableEventDefinition): void {
  validateDurableEventType(definition.type)
  validatePayloadVersion(definition.payloadVersion)
  if (typeof definition.ignorable !== 'boolean') {
    throw new SessionError('SESSION_EVENT_INVALID', 'event definition ignorable must be boolean', {
      details: { type: definition.type, payloadVersion: definition.payloadVersion },
    })
  }
  if (typeof definition.decode !== 'function') {
    throw new SessionError('SESSION_EVENT_INVALID', 'event definition must provide a decoder', {
      details: { type: definition.type, payloadVersion: definition.payloadVersion },
    })
  }
}

/** Create one frozen durable event definition. */
export function createDurableEventDefinition<TPayload extends JsonValue>(
  options: DurableEventDefinitionOptions<TPayload>,
): DurableEventDefinition<TPayload> {
  validateDefinition(options)
  return Object.freeze({
    type: options.type,
    payloadVersion: options.payloadVersion,
    ignorable: options.ignorable,
    decode: options.decode,
  })
}

function decodeEndedPayload(value: JsonValue): SessionEndedPayload {
  const copy = snapshotJson(value, 'session ended payload')
  if (copy === null || Array.isArray(copy) || typeof copy !== 'object') {
    throw new TypeError('session ended payload must be an object')
  }
  const keys = Object.keys(copy)
  if (keys.some(key => key !== 'reason')) {
    throw new TypeError('session ended payload contains an unknown field')
  }
  if ('reason' in copy && typeof copy.reason !== 'string') {
    throw new TypeError('session ended reason must be a string')
  }
  return copy as SessionEndedPayload
}

/** Built-in required event that irreversibly ends one Session. */
export const sessionEndedEvent: DurableEventDefinition<SessionEndedPayload> = createDurableEventDefinition({
  type: 'session/ended',
  payloadVersion: 1,
  ignorable: false,
  decode: decodeEndedPayload,
})

/** Create an immutable Catalog that always includes `session/ended@1`. */
export function createDurableEventCatalog(
  definitions: readonly DurableEventDefinition[] = [],
): DurableEventCatalog {
  const byKey = new Map<string, DurableEventDefinition>()
  const identities = new Set<DurableEventDefinition>()
  for (const definition of [sessionEndedEvent, ...definitions]) {
    validateDefinition(definition)
    Object.freeze(definition)
    const key = definitionKey(definition.type, definition.payloadVersion)
    const existing = byKey.get(key)
    if (existing !== undefined && existing !== definition) {
      throw new SessionError(
        'SESSION_EVENT_DEFINITION_CONFLICT',
        `conflicting durable event definition for ${definition.type}@${definition.payloadVersion}`,
        { details: { type: definition.type, payloadVersion: definition.payloadVersion } },
      )
    }
    byKey.set(key, definition)
    identities.add(definition)
  }
  return Object.freeze({
    resolve: (type: string, payloadVersion: number) => byKey.get(definitionKey(type, payloadVersion)),
    contains: (definition: DurableEventDefinition) => identities.has(definition),
  })
}

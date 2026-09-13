import type { JsonObject, JsonValue } from '../foundation/json.js'
import { CommunicationError } from './errors.js'

/** Construct one stable Message Envelope validation error. */
export function invalidEnvelope(message: string, cause?: unknown): CommunicationError {
  return new CommunicationError(
    'MESSAGE_ENVELOPE_INVALID',
    message,
    cause === undefined ? {} : { cause },
  )
}

/** Require one JSON object field container. */
export function requireRecord(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw invalidEnvelope(`${label} must be a JSON object`)
  }
  return value as JsonObject
}

/** Require the exact mandatory and optional field names of one protocol record. */
export function requireExactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw invalidEnvelope(`${label} is missing field ${key}`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalidEnvelope(`${label} contains unknown field ${key}`)
  }
}

/** Require one JSON string field. */
export function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') throw invalidEnvelope(`${label} must be a string`)
  return value
}

/** Require one JSON number field. */
export function requireNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number') throw invalidEnvelope(`${label} must be a number`)
  return value
}

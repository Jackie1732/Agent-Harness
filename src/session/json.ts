import { assertJsonValue } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'

function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value)) freezeJson(child)
  return Object.freeze(value)
}

/** Validate, serialize, copy, and deeply freeze one durable JSON value. */
export function snapshotJson(value: unknown, label: string): JsonValue {
  assertJsonValue(value, label)
  const encoded = JSON.stringify(value)
  const parsed: unknown = JSON.parse(encoded)
  assertJsonValue(parsed, label)
  return freezeJson(parsed)
}

/** Deeply freeze a newly decoded JSON value without serializing it again. */
export function freezeDecodedJson(value: JsonValue): JsonValue {
  return freezeJson(value)
}

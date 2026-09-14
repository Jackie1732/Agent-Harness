import type { JsonObject, JsonValue } from '../foundation/json.js'
import { ModelError } from './errors.js'

/** Internal scalar readers never echo values or untrusted property names. */
export function object(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelError('MODEL_REQUEST_INVALID', `${label} must be an object`)
  }
  return value as JsonObject
}

export function keys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new ModelError('MODEL_REQUEST_INVALID', 'model value has missing or unsupported fields')
  }
}

export function text(value: JsonValue | undefined, label: string, maxBytes = Number.MAX_SAFE_INTEGER, empty = true): string {
  if (typeof value !== 'string' || !empty && value.length === 0 || typeof value === 'string' && Buffer.byteLength(value) > maxBytes) {
    throw new ModelError('MODEL_REQUEST_INVALID', `${label} must be a bounded string`)
  }
  return value
}

export function integer(value: JsonValue | undefined, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) {
    throw new ModelError('MODEL_REQUEST_INVALID', `${label} must be a safe integer in range`)
  }
  return value
}

export function list(value: JsonValue | undefined, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new ModelError('MODEL_REQUEST_INVALID', `${label} must be an array`)
  return value as readonly JsonValue[]
}

export function bool(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== 'boolean') throw new ModelError('MODEL_REQUEST_INVALID', `${label} must be boolean`)
  return value
}

export function oneOf<T extends string>(value: JsonValue | undefined, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) {
    throw new ModelError('MODEL_REQUEST_INVALID', `${label} has an unsupported value`)
  }
  return value as T
}

export function boundedIdentifier(value: JsonValue | undefined, label: string): string {
  const result = text(value, label, 128, false)
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(result)) {
    throw new ModelError('MODEL_REQUEST_INVALID', `${label} has unsupported syntax`)
  }
  return result
}

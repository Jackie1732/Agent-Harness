import { assertJsonValue } from '../../../foundation/json.js'
import type { JsonObject, JsonValue } from '../../../foundation/json.js'
import type { ModelUsageCounts } from '../../contract.js'
import { ModelError } from '../../errors.js'

/** Wire decoders deliberately report protocol errors, never input/configuration errors. */
export function wireObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw wireInvalid()
  return value as JsonObject
}
export function wireJson(text: string): JsonObject {
  try { const value: unknown = JSON.parse(text); assertJsonValue(value); return wireObject(value) }
  catch { throw wireInvalid() }
}
export function wireKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) throw wireInvalid()
}
export function wireText(value: unknown, maximum = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum) throw wireInvalid()
  return value
}
export function wireId(value: unknown): string {
  const id = wireText(value, 256)
  if (id.length === 0) throw wireInvalid()
  return id
}
export function wireIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw wireInvalid()
  return value
}
export function wireArray(value: unknown): readonly JsonValue[] {
  if (!Array.isArray(value)) throw wireInvalid()
  return value as readonly JsonValue[]
}
export function wireInvalid(): ModelError { return new ModelError('MODEL_PROTOCOL_INVALID', 'model wire protocol has invalid or unsupported semantic content') }

/** Translate explicit cumulative fields without inventing missing counters or totals. */
export function usageFields(value: unknown, mapping: Readonly<Record<string, keyof ModelUsageCounts>>): ModelUsageCounts {
  const input = wireObject(value)
  const result: Record<string, number> = {}
  for (const [source, target] of Object.entries(mapping)) {
    if (Object.hasOwn(input, source)) result[target] = wireIndex(input[source])
  }
  return result
}

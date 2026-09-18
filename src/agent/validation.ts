import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { isCanonicalIsoTimestamp } from '../foundation/protocol-scalars.js'
import { boundedJson } from '../schema/bounded-json.js'
import { parseSessionEventId } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import { invalidAgent } from './errors.js'

/** Decoder ceilings apply before a Session's smaller, configurable record limit. */
export function agentJson(value: unknown): JsonValue {
  try { return boundedJson(value, { maxBytes: 4 * 1024 * 1024, maxDepth: 48, maxNodes: 100000 }) }
  catch { return invalidAgent('invalid-json') }
}
export function record(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidAgent('object-required')
  return value as JsonObject
}
export function exact(value: JsonObject, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) invalidAgent('invalid-fields')
}
export function text(value: unknown, bytes = 1024, empty = false): string {
  if (typeof value !== 'string' || !empty && value.length === 0 || Buffer.byteLength(value) > bytes) invalidAgent('invalid-text')
  return value
}
export function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) invalidAgent('invalid-integer')
  return value
}
export function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidAgent('invalid-boolean')
  return value
}
export function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalidAgent('invalid-variant')
  return value as T
}
export function array(value: unknown, maximum = 10000): readonly JsonValue[] {
  if (!Array.isArray(value) || value.length > maximum) invalidAgent('invalid-array')
  return value as readonly JsonValue[]
}
export function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalidAgent('duplicate-entry')
}
export function eventId(value: unknown): SessionEventId {
  const id = text(value, 128)
  try { parseSessionEventId(id) } catch { invalidAgent('invalid-event-reference') }
  return id as SessionEventId
}
export function nullableId(value: unknown): SessionEventId | null { return value === null ? null : eventId(value) }
export function timestamp(value: unknown): string {
  const result = text(value, 32)
  if (!isCanonicalIsoTimestamp(result)) invalidAgent('invalid-timestamp')
  return result
}
export function equal(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(agentJson(left))).equals(Buffer.from(canonicalJsonBytes(agentJson(right))))
}

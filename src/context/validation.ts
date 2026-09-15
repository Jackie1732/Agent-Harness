import { createHash } from 'node:crypto'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { boundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import { parseSessionEventId, parseSessionId, sessionLogPosition } from '../session/ids.js'
import type { SessionEventId, SessionId } from '../session/ids.js'
import type { SessionProjectionCoverage } from '../session/types.js'
import type { ContextSourceReference, ContextTextReference, ContextUnitReference } from './contract.js'
import { ContextError, invalidContext } from './errors.js'

/** Protocol ceilings bound decoding even before a Profile is available. */
export const contextJsonCeiling = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxDepth: 64, maxNodes: 250000 })
export const contextArrayCeiling = 10000
export const unitSelectors = ['user-input', 'assistant-response', 'tool-exchange', 'tool-observation',
  'peer-message', 'outbox-message', 'memory', 'compacted-history', 'legacy', 'diagnostic'] as const
const textSelectors = ['input-text', 'tool-text', 'inbox-text', 'memory-text', 'compaction-text', 'model-text'] as const

export function contextJson(value: unknown, maximumBytes = contextJsonCeiling.maxBytes): JsonValue {
  try { return boundedJson(value, { ...contextJsonCeiling, maxBytes: Math.min(contextJsonCeiling.maxBytes, maximumBytes) }) }
  catch (reason) {
    throw new ContextError('CONTEXT_REQUEST_INVALID', reason instanceof JsonBoundaryError ? `json-${reason.reason}` : 'json')
  }
}
export function record(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidContext('object')
  return value as JsonObject
}
export function exact(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) invalidContext('fields')
}
export function array(value: unknown, maximum = contextArrayCeiling): readonly JsonValue[] {
  if (!Array.isArray(value) || value.length > maximum) invalidContext('array')
  return value as readonly JsonValue[]
}
export function text(value: unknown, maximum = 1024 * 1024, empty = false): string {
  if (typeof value !== 'string' || !empty && value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum) invalidContext('text')
  return value
}
export function integer(value: unknown, minimum = 0, maximum = 1000000000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) invalidContext('integer')
  return value
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidContext('boolean')
  return value
}
export function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalidContext('variant')
  return value as T
}
export function identifier(value: unknown): string {
  const result = text(value, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(result)) invalidContext('identifier')
  return result
}
export function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
export function tags(value: unknown): readonly string[] {
  const result = array(value, 64).map(item => {
    const tag = text(item, 64)
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(tag)) invalidContext('tag')
    return tag
  })
  unique(result)
  return result
}
export function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalidContext('duplicate')
}
export function eventId(value: unknown): SessionEventId {
  const id = text(value, 128)
  try { parseSessionEventId(id) } catch { invalidContext('event-identity') }
  return id as SessionEventId
}
export function sessionId(value: unknown): SessionId {
  try { return parseSessionId(text(value, 36)) } catch { return invalidContext('session-identity') }
}
export function previous(value: unknown): SessionEventId | null { return value === null ? null : eventId(value) }
export function sourceKey(reference: ContextSourceReference): string {
  return `${reference.eventId}#${reference.selector}${reference.selector === 'model-text' ? `:${reference.outputBlockIndex}` : ''}`
}
export function unitReference(value: unknown): ContextUnitReference {
  const input = record(value)
  exact(input, ['eventId', 'selector'])
  eventId(input.eventId); choice(input.selector, unitSelectors)
  return input as ContextUnitReference
}
export function textReference(value: unknown): ContextTextReference {
  const input = record(value)
  const selector = choice(input.selector, textSelectors)
  exact(input, selector === 'model-text' ? ['eventId', 'selector', 'outputBlockIndex'] : ['eventId', 'selector'])
  eventId(input.eventId)
  if (selector === 'model-text') integer(input.outputBlockIndex)
  return input as ContextTextReference
}
export function sourceReference(value: unknown): ContextSourceReference {
  const input = record(value)
  return (textSelectors as readonly unknown[]).includes(input.selector) ? textReference(input) : unitReference(input)
}
export function unitReferences(value: unknown): readonly ContextUnitReference[] {
  const refs = array(value).map(unitReference)
  unique(refs.map(sourceKey))
  return refs
}
export function coverage(value: unknown): readonly SessionProjectionCoverage[] {
  const values = array(value, 128)
  if (values.length === 0) invalidContext('coverage-empty')
  const items = values.map(item => {
    const entry = record(item); exact(entry, ['sessionId', 'through'])
    sessionId(entry.sessionId)
    try { sessionLogPosition(entry.through as number) } catch { invalidContext('coverage-position') }
    return entry as unknown as SessionProjectionCoverage
  })
  unique(items.map(item => item.sessionId))
  return items
}
export function digest(value: JsonValue): string { return createHash('sha256').update(canonicalJsonBytes(value)).digest('hex') }
export function digestValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalidContext('digest')
  return value
}
export function jsonBytes(value: JsonValue): number { return canonicalJsonBytes(value).byteLength }
export function equalJson(left: JsonValue, right: JsonValue): boolean {
  return Buffer.from(canonicalJsonBytes(left)).equals(Buffer.from(canonicalJsonBytes(right)))
}
export function canonicalText(value: JsonValue): string { return Buffer.from(canonicalJsonBytes(value)).toString('utf8') }

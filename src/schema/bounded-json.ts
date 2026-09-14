import { types as nodeTypes } from 'node:util'
import { snapshotJson } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'

/** Limits are applied before recursive JSON, canonical encoding, or schema compilation. */
export interface JsonValidationLimits {
  readonly maxBytes: number
  readonly maxDepth: number
  readonly maxNodes: number
}

/** A bounded boundary error. It deliberately contains no input values or property paths. */
export class JsonBoundaryError extends TypeError {
  constructor(readonly reason: 'invalid' | 'bytes' | 'depth' | 'nodes') {
    super(`JSON boundary rejected ${reason}`)
    this.name = 'JsonBoundaryError'
  }
}

/** Validate limits; depth also has a protocol ceiling protecting downstream recursive code. */
export function validateJsonLimits(limits: JsonValidationLimits): void {
  for (const value of [limits.maxBytes, limits.maxDepth, limits.maxNodes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new JsonBoundaryError('invalid')
  }
  if (limits.maxDepth > 128) throw new JsonBoundaryError('depth')
}

/**
 * Iterative preflight, followed by the existing immutable JSON boundary. Accessors and
 * proxies are rejected without evaluation. Shared acyclic values are counted per occurrence.
 */
export function boundedJson(value: unknown, limits: JsonValidationLimits): JsonValue {
  validateJsonLimits(limits)
  type Frame = { value: unknown; depth: number; exit?: boolean }
  const stack: Frame[] = [{ value, depth: 0 }]
  const active = new Set<object>()
  let nodes = 0
  let bytes = 0
  const addBytes = (count: number): void => {
    bytes += count
    if (bytes > limits.maxBytes) throw new JsonBoundaryError('bytes')
  }
  const stringBytes = (text: string): number => {
    // Reject the raw lower bound before allocating an escaped representation.
    if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) throw new JsonBoundaryError('bytes')
    return Buffer.byteLength(JSON.stringify(text), 'utf8')
  }
  while (stack.length > 0) {
    const frame = stack.pop()!
    const item = frame.value
    if (frame.exit) { active.delete(item as object); continue }
    if (++nodes > limits.maxNodes) throw new JsonBoundaryError('nodes')
    if (frame.depth > limits.maxDepth) throw new JsonBoundaryError('depth')
    if (item === null) { addBytes(4); continue }
    if (typeof item === 'string') { addBytes(stringBytes(item)); continue }
    if (typeof item === 'boolean') { addBytes(item ? 4 : 5); continue }
    if (typeof item === 'number' && Number.isFinite(item)) {
      addBytes(JSON.stringify(item).length); continue
    }
    if (typeof item !== 'object' || nodeTypes.isProxy(item)) throw new JsonBoundaryError('invalid')
    if (active.has(item)) throw new JsonBoundaryError('invalid')
    const array = Array.isArray(item)
    const prototype: unknown = Object.getPrototypeOf(item)
    if (!array && prototype !== null && (typeof prototype !== 'object' || Object.getPrototypeOf(prototype) !== null)) {
      throw new JsonBoundaryError('invalid')
    }
    if (array && item.length > limits.maxNodes) throw new JsonBoundaryError('nodes')
    if (Object.getOwnPropertySymbols(item).length !== 0) throw new JsonBoundaryError('invalid')
    const names = Object.getOwnPropertyNames(item)
    if (names.length > limits.maxNodes + (array ? 1 : 0)) throw new JsonBoundaryError('nodes')
    if (array && names.length !== item.length + 1) throw new JsonBoundaryError('invalid')
    active.add(item)
    stack.push({ value: item, depth: frame.depth, exit: true })
    addBytes(2)
    let count = 0
    for (const name of names) {
      if (array && name === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(item, name)
      if (descriptor === undefined || !('value' in descriptor) || (!array && !descriptor.enumerable)) {
        throw new JsonBoundaryError('invalid')
      }
      if (array && (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= item.length)) throw new JsonBoundaryError('invalid')
      if (count++ > 0) addBytes(1)
      if (!array) addBytes(stringBytes(name) + 1)
      if (nodes + stack.length > limits.maxNodes + active.size) throw new JsonBoundaryError('nodes')
      stack.push({ value: descriptor.value, depth: frame.depth + 1 })
    }
  }
  // Preflight has made the existing recursive assertion/copy bounded and getter-free.
  return snapshotJson(value)
}

/** Check text bytes before JSON.parse, then apply the same immutable data limits. */
export function parseBoundedJson(text: string, limits: JsonValidationLimits): JsonValue {
  validateJsonLimits(limits)
  if (typeof text !== 'string') throw new JsonBoundaryError('invalid')
  if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) throw new JsonBoundaryError('bytes')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new JsonBoundaryError('invalid') }
  return boundedJson(parsed, limits)
}

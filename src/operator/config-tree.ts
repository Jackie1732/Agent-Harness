import type { JsonObject, JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { HostError } from '../host/errors.js'
import { boundedJson } from '../schema/bounded-json.js'
import type { ConfigOperation } from './config-types.js'

function invalid(reason: string): never { throw new HostError('HOST_CONFIG_INVALID', `config-operation-${reason}`) }
/** Decode data-only operations before an editor touches any file. */
export function decodeConfigOperations(value: unknown): readonly ConfigOperation[] {
  const operations = boundedJson(value, { maxBytes: 16 * 1024 * 1024, maxDepth: 64, maxNodes: 200000 })
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 10000) invalid('list')
  return operations.map(value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('object')
    const item = value as JsonObject
    if (item.op !== 'set' && item.op !== 'insert' && item.op !== 'remove' || typeof item.pointer !== 'string') invalid('fields')
    const keys = item.op === 'remove' ? ['op', 'pointer'] : ['op', 'pointer', 'value']
    if (Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) invalid('fields')
    return item as unknown as ConfigOperation
  })
}
function pointerTokens(pointer: string): readonly string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/') || /~(?:[^01]|$)/.test(pointer)) invalid('pointer')
  return pointer.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
}
function index(token: string, length: number, insert: boolean): number {
  if (insert && token === '-') return length
  if (!/^(?:0|[1-9][0-9]*)$/.test(token)) invalid('array-index')
  const value = Number(token)
  if (!Number.isSafeInteger(value) || value >= length + (insert ? 1 : 0)) invalid('array-index')
  return value
}
/** Apply a whole candidate in memory; the input and each operation value remain immutable. */
export function applyConfigTreeOperations(value: JsonValue, operations: readonly ConfigOperation[]): JsonValue {
  if (operations.length === 0) invalid('empty')
  let result = structuredClone(value)
  for (const operation of operations) {
    const tokens = pointerTokens(operation.pointer)
    if (tokens.length === 0) {
      if (operation.op !== 'set') invalid('root')
      result = structuredClone(operation.value)
      continue
    }
    let parent = result
    for (const token of tokens.slice(0, -1)) {
      if (parent === null || typeof parent !== 'object') invalid('parent')
      if (Array.isArray(parent)) parent = parent[index(token, parent.length, false)]!
      else {
        if (!Object.hasOwn(parent, token)) invalid('missing')
        parent = (parent as JsonObject)[token]!
      }
    }
    if (parent === null || typeof parent !== 'object') invalid('parent')
    const token = tokens.at(-1)!
    if (Array.isArray(parent)) {
      const position = index(token, parent.length, operation.op === 'insert'), array = parent as JsonValue[]
      if (operation.op === 'insert') array.splice(position, 0, structuredClone(operation.value))
      else if (operation.op === 'remove') array.splice(position, 1)
      else array[position] = structuredClone(operation.value)
    } else {
      const record = parent as Record<string, JsonValue>, exists = Object.hasOwn(record, token)
      if (operation.op === 'insert' ? exists : !exists) invalid(exists ? 'exists' : 'missing')
      if (operation.op === 'remove') delete record[token]
      else Object.defineProperty(record, token, { value: structuredClone(operation.value), enumerable: true, writable: true, configurable: true })
    }
  }
  return snapshotJson(result)
}
/** Compare JSON values without interpreting fields as running state. */
export function changedConfigPointers(before: JsonValue, after: JsonValue, pointer = ''): readonly string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object'
    || Array.isArray(before) !== Array.isArray(after)) return [pointer]
  const left = before as JsonObject, right = after as JsonObject
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].flatMap(key => {
    const child = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
    return !Object.hasOwn(left, key) || !Object.hasOwn(right, key) ? [child] : changedConfigPointers(left[key]!, right[key]!, child)
  })
}

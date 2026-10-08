/** JSON tree navigation is independent of publication and domain validation. */
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { plainText } from './text.js'

export interface TreeRow { readonly pointer: string; readonly label: string; readonly value: JsonValue; readonly depth: number }
export const VALUE_TYPES = ['string', 'number', 'boolean', 'null', 'object', 'array'] as const
export type ValueType = typeof VALUE_TYPES[number]

/** @param key One object key or array index. @returns A JSON Pointer segment. */
export function pointerSegment(key: string): string { return key.replace(/~/g, '~0').replace(/\//g, '~1') }

/** @param value Any JSON value. @returns Whether the value has child nodes. */
export function isContainer(value: JsonValue): value is JsonObject | readonly JsonValue[] { return value !== null && typeof value === 'object' }

/**
 * Flatten only expanded nodes while keeping exact pointers and original values.
 * @param value Original draft.
 * @param expanded Open container pointers.
 * @returns Visible navigation rows.
 */
export function treeRows(value: JsonValue, expanded: ReadonlySet<string>): readonly TreeRow[] {
  const rows: TreeRow[] = []
  const visit = (node: JsonValue, pointer: string, label: string, depth: number) => {
    rows.push({ pointer, label, value: node, depth })
    if (!isContainer(node) || !expanded.has(pointer)) return
    for (const [key, child] of Object.entries(node)) visit(child as JsonValue, pointer + '/' + pointerSegment(key), key, depth + 1)
  }
  visit(value, '', '(根)', 0)
  return rows
}

/** @param value Original node. @returns Its selectable JSON value type. */
export function valueType(value: JsonValue): ValueType {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value as 'string' | 'number' | 'boolean'
}

/** @param type Requested type. @returns An empty typed value for structural editing. */
export function emptyValue(type: ValueType): JsonValue {
  switch (type) {
    case 'string': return ''
    case 'number': return 0
    case 'boolean': return false
    case 'null': return null
    case 'object': return {}
    case 'array': return []
  }
}

/** @param row Original row. @returns A plain summary without terminal controls. */
export function rowSummary(row: TreeRow): string {
  const value = row.value
  return isContainer(value) ? `${valueType(value)} (${Object.keys(value).length})` : plainText(JSON.stringify(value))
}

/**
 * Use protocol metadata to populate required fields; arbitrary JSON remains editable.
 * @param schema An existing owner schema, rather than a duplicate business schema.
 * @returns An editable initial value requiring the operator to fill identifiers and content.
 */
export function schemaSeed(schema: JsonObject): JsonValue {
  if (Object.hasOwn(schema, 'const')) return schema.const!
  if (Array.isArray(schema.enum)) return schema.enum[0] ?? null
  const variants = schema.oneOf ?? schema.anyOf
  if (Array.isArray(variants) && variants[0] !== null && typeof variants[0] === 'object') return schemaSeed(variants[0] as JsonObject)
  if (schema.type === 'object') {
    const properties = schema.properties as JsonObject | undefined
    const required = Array.isArray(schema.required) ? schema.required : []
    return Object.fromEntries(required.map(key => [String(key), schemaSeed((properties?.[String(key)] ?? {}) as JsonObject)]))
  }
  if (schema.type === 'array') return []
  if (schema.type === 'integer' || schema.type === 'number') return typeof schema.minimum === 'number' ? schema.minimum : 0
  if (schema.type === 'boolean') return false
  if (schema.type === 'null') return null
  return ''
}

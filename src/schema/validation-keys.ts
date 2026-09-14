import type { JsonObject, JsonValue } from '../foundation/json.js'

/**
 * Ajv 8.20.0 intentionally excludes __proto__ from schema property iteration. A bijection
 * on ALL data property names avoids that special case without changing JSON Schema truth.
 * UTF-16 units (not UTF-8) preserve distinct lone surrogates. Original data is never mutated.
 */
export function validationKey(key: string): string {
  let result = 'p'
  for (let index = 0; index < key.length; index++) result += key.charCodeAt(index).toString(16).padStart(4, '0')
  return result
}
export function validationData(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(validationData)
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [validationKey(key), validationData(child)]))
}
/** Only Schema properties/required and enum data are renamed; keywords are unchanged. */
export function validationSchema(schema: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (key === 'properties') {
      return [key, Object.fromEntries(Object.entries(value as JsonObject).map(([name, child]) => [validationKey(name), validationSchema(child as JsonObject)]))]
    }
    if (key === 'required') return [key, (value as readonly string[]).map(validationKey)]
    if (key === 'enum') return [key, (value as readonly JsonValue[]).map(validationData)]
    if (key === 'items') return [key, validationSchema(value as JsonObject)]
    return [key, value]
  }))
}

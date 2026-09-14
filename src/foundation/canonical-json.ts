import { assertJsonValue } from './json.js'
import type { JsonValue } from './json.js'

function encodeCanonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError('canonical JSON value cannot be encoded')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(item => encodeCanonical(item)).join(',')}]`
  const record = value as { readonly [key: string]: JsonValue }
  const fields = Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${encodeCanonical(record[key] as JsonValue)}`)
  return `{${fields.join(',')}}`
}

/** Encode one JSON value with recursively sorted object keys and no whitespace. */
export function canonicalJsonBytes(value: JsonValue): Uint8Array {
  assertJsonValue(value, 'canonical JSON value')
  return Buffer.from(encodeCanonical(value), 'utf8')
}

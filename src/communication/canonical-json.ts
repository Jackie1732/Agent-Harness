import { createHash } from 'node:crypto'
import { assertJsonValue } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'
import type { MessageEnvelope } from './types.js'

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

/** Compute the stable SHA-256 digest of one canonical Message Envelope. */
export function messageEnvelopeDigest(envelope: MessageEnvelope): string {
  return createHash('sha256').update(canonicalJsonBytes(envelope)).digest('hex')
}

/** Compare complete canonical bytes after an optional digest fast path. */
export function equalMessageEnvelopes(
  left: MessageEnvelope,
  right: MessageEnvelope,
  leftDigest = messageEnvelopeDigest(left),
  rightDigest = messageEnvelopeDigest(right),
): boolean {
  if (leftDigest !== rightDigest) return false
  return Buffer.compare(Buffer.from(canonicalJsonBytes(left)), Buffer.from(canonicalJsonBytes(right))) === 0
}

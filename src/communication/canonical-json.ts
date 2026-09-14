import { createHash } from 'node:crypto'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { MessageEnvelope } from './types.js'

// Retain the existing internal import path while sharing the neutral encoder.
export { canonicalJsonBytes } from '../foundation/canonical-json.js'

/** Compute the stable SHA-256 digest of one canonical Message Envelope. */
export function messageEnvelopeDigest(envelope: MessageEnvelope): string {
  return createHash('sha256').update(canonicalJsonBytes(envelope)).digest('hex')
}

/** Compare the complete canonical bytes of two Message Envelopes. */
export function equalMessageEnvelopes(left: MessageEnvelope, right: MessageEnvelope): boolean {
  return Buffer.compare(Buffer.from(canonicalJsonBytes(left)), Buffer.from(canonicalJsonBytes(right))) === 0
}

import { randomUUID } from 'node:crypto'
import { brand } from '../foundation/brand.js'
import type { Brand } from '../foundation/brand.js'
import { isCanonicalUuid } from '../foundation/protocol-scalars.js'
import { CommunicationError } from './errors.js'

/** Stable identity of one logical message across every delivery attempt. */
export type MessageId = Brand<string, 'MessageId'>

/** Stable identity of one explicitly created ordered message channel. */
export type ChannelId = Brand<string, 'ChannelId'>

/** One-based sender-local sequence for one recipient and Channel. */
export type ChannelSequence = Brand<number, 'ChannelSequence'>

/** Injectable source of communication identities. */
export interface CommunicationIdentitySource {
  /** @returns A new canonical Message identity. */
  nextMessageId(): MessageId
  /** @returns A new canonical Channel identity. */
  nextChannelId(): ChannelId
}

function invalidIdentifier(label: string, value: unknown): CommunicationError {
  return new CommunicationError(
    'MESSAGE_IDENTIFIER_INVALID',
    `${label} is not canonical`,
    { details: { label, value: typeof value === 'string' ? value : String(value) } },
  )
}

/** Parse a canonical lower-case UUID Message identity. */
export function parseMessageId(value: string): MessageId {
  if (!isCanonicalUuid(value)) throw invalidIdentifier('message id', value)
  return brand<string, 'MessageId'>(value)
}

/** Parse a canonical lower-case UUID Channel identity. */
export function parseChannelId(value: string): ChannelId {
  if (!isCanonicalUuid(value)) throw invalidIdentifier('channel id', value)
  return brand<string, 'ChannelId'>(value)
}

/** Create a validated one-based Channel sequence. */
export function channelSequence(value: number): ChannelSequence {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidIdentifier('channel sequence', value)
  }
  return brand<number, 'ChannelSequence'>(value)
}

/** Cryptographically random production communication identity source. */
export const systemCommunicationIdentitySource: CommunicationIdentitySource = Object.freeze({
  nextMessageId: () => parseMessageId(randomUUID()),
  nextChannelId: () => parseChannelId(randomUUID()),
})

/** Create a new Channel identity from an explicit or production source. */
export function createChannelId(
  source: CommunicationIdentitySource = systemCommunicationIdentitySource,
): ChannelId {
  return parseChannelId(source.nextChannelId())
}

import { describe, expect, it } from 'vitest'
import {
  canonicalJsonBytes,
  channelSequence,
  createMessageCatalog,
  createMessageDefinition,
  decodeMessagePayload,
  decodeMessageEnvelope,
  equalMessageEnvelopes,
  formatSessionAddress,
  messageEnvelopeDigest,
  parseChannelId,
  parseMessageId,
  parseSessionId,
} from '../../src/index.js'
import type { JsonObject, MessageEnvelope } from '../../src/index.js'
import { messageCatalog, requestMessage } from './fixtures.js'

const sender = formatSessionAddress(parseSessionId('00000000-0000-4000-8000-000000000111'))
const recipient = formatSessionAddress(parseSessionId('00000000-0000-4000-8000-000000000112'))
const messageId = parseMessageId('10000000-0000-4000-8000-000000000111')
const channelId = parseChannelId('20000000-0000-4000-8000-000000000111')

function envelope(payload: JsonObject = { nested: { b: 2, a: 1 } }): MessageEnvelope {
  return decodeMessageEnvelope({
    envelopeVersion: 1,
    messageId,
    sender,
    recipient,
    channelId,
    channelSequence: 1,
    correlationId: messageId,
    createdAt: '2026-09-13T00:00:00.000Z',
    type: requestMessage.type,
    payloadVersion: 1,
    payload,
  })
}

describe('communication protocol values', () => {
  it('validates domain identities and envelope causal fields', () => {
    expect(channelSequence(1)).toBe(1)
    expect(() => parseMessageId('abcdef00-0000-4000-8000-000000000111'.toUpperCase())).toThrowError(
      expect.objectContaining({ code: 'MESSAGE_IDENTIFIER_INVALID' }),
    )
    expect(() => channelSequence(0)).toThrowError(expect.objectContaining({ code: 'MESSAGE_IDENTIFIER_INVALID' }))
    expect(() => decodeMessageEnvelope({ ...envelope(), correlationId: parseMessageId('10000000-0000-4000-8000-000000000112') }))
      .toThrowError(expect.objectContaining({ code: 'MESSAGE_ENVELOPE_INVALID' }))
    expect(() => decodeMessageEnvelope({ ...envelope(), replyTo: messageId }))
      .toThrowError(expect.objectContaining({ code: 'MESSAGE_ENVELOPE_INVALID' }))
  })

  it('canonicalizes object keys recursively while preserving array order', () => {
    const left = envelope({ nested: { b: 2, a: 1 }, array: [1, 2] })
    const right = envelope({ array: [1, 2], nested: { a: 1, b: 2 } })
    const reorderedArray = envelope({ nested: { b: 2, a: 1 }, array: [2, 1] })

    expect(Buffer.from(canonicalJsonBytes(left)).toString()).toBe(Buffer.from(canonicalJsonBytes(right)).toString())
    expect(messageEnvelopeDigest(left)).toBe(messageEnvelopeDigest(right))
    expect(equalMessageEnvelopes(left, right)).toBe(true)
    expect(equalMessageEnvelopes(left, reorderedArray)).toBe(false)
  })

  it('uses immutable exact Definition identities in an independent Catalog', () => {
    const impostor = createMessageDefinition<JsonObject>({
      type: requestMessage.type,
      payloadVersion: 1,
      decode: value => value as JsonObject,
    })
    expect(messageCatalog.contains(requestMessage)).toBe(true)
    expect(messageCatalog.contains(impostor)).toBe(false)
    expect(() => createMessageCatalog([requestMessage, impostor])).toThrowError(
      expect.objectContaining({ code: 'MESSAGE_DEFINITION_CONFLICT' }),
    )
    expect(Object.isFrozen(envelope())).toBe(true)
    expect(() => createMessageDefinition({ type: 'Bad Type', payloadVersion: 1, decode: value => value }))
      .toThrowError(expect.objectContaining({ code: 'MESSAGE_DEFINITION_INVALID' }))
  })

  it('does not copy rejected payload content into structured error diagnostics', () => {
    const rejecting = createMessageDefinition<JsonObject>({
      type: 'test/rejecting',
      payloadVersion: 1,
      decode: value => { throw new Error(`unsafe ${JSON.stringify(value)}`) },
    })
    let failure: unknown
    try {
      decodeMessagePayload(rejecting, { secret: 'do-not-log' })
    } catch (cause) {
      failure = cause
    }
    expect(JSON.stringify(failure)).not.toContain('do-not-log')
    expect(failure).toMatchObject({ code: 'MESSAGE_PAYLOAD_INVALID' })
  })
})

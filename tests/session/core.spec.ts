import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createDurableEventCatalog,
  createDurableEventDefinition,
  formatSessionAddress,
  formatSessionEventId,
  parseSessionAddress,
  parseSessionEventId,
  parseSessionId,
  sessionLogPosition,
  sessionSequence,
} from '../../src/index.js'
import { decodeSessionHeader, decodeStoredSessionEvent, encodeSessionHeader, encodeStoredSessionEvent } from '../../src/session/codec.js'
import { encodeFrame, FrameScanner } from '../../src/session/frame.js'
import type { JsonObject, SessionHeader, StoredSessionEvent } from '../../src/index.js'

const id = parseSessionId('abcdef00-0000-4000-8000-000000000001')

function header(): SessionHeader {
  return Object.freeze({
    formatVersion: 1,
    sessionId: id,
    address: formatSessionAddress(id),
    createdAt: '2026-09-13T00:00:00.000Z',
  })
}

function event(): StoredSessionEvent {
  const sequence = sessionSequence(1)
  return Object.freeze({
    envelopeVersion: 1,
    sessionId: id,
    eventId: formatSessionEventId(id, sequence),
    sequence,
    recordedAt: '2026-09-13T00:00:01.000Z',
    type: 'test/recorded',
    payloadVersion: 1,
    payload: Object.freeze({ value: 3 }),
  })
}

describe('Session identities and Catalog', () => {
  it('round-trips only canonical identities, addresses, positions, and event ids', () => {
    const address = formatSessionAddress(id)
    const eventId = formatSessionEventId(id, sessionSequence(7))

    expect(parseSessionAddress(address)).toBe(id)
    expect(parseSessionEventId(eventId)).toEqual({ sessionId: id, sequence: 7 })
    expect(sessionLogPosition(0)).toBe(0)
    expect(() => parseSessionId(String(id).toUpperCase())).toThrowError(/canonical/)
    expect(() => parseSessionAddress(` ${address}`)).toThrowError(/canonical/)
    expect(() => sessionSequence(0)).toThrowError(/positive/)
    expect(() => sessionLogPosition(-1)).toThrowError(/non-negative/)
    expect(() => sessionLogPosition(-0)).toThrowError(/non-negative/)
  })

  it('freezes definitions and rejects a second identity for one type/version', () => {
    const first = createDurableEventDefinition<JsonObject>({
      type: 'test/item',
      payloadVersion: 1,
      ignorable: false,
      decode: value => value as JsonObject,
    })
    const catalog = createDurableEventCatalog([first, first])
    const impostor = createDurableEventDefinition<JsonObject>({
      type: 'test/item',
      payloadVersion: 1,
      ignorable: false,
      decode: value => value as JsonObject,
    })

    expect(Object.isFrozen(first)).toBe(true)
    expect(catalog.resolve('test/item', 1)).toBe(first)
    expect(catalog.contains(first)).toBe(true)
    expect(catalog.contains(impostor)).toBe(false)
    expect(() => createDurableEventCatalog([first, impostor])).toThrowError(
      expect.objectContaining({ code: 'SESSION_EVENT_DEFINITION_CONFLICT' }),
    )
    expect(catalog.resolve('session/ended', 1)).toBeDefined()
  })

  it('keeps payload versions independent within one event type', () => {
    const first = createDurableEventDefinition<JsonObject>({
      type: 'test/versioned',
      payloadVersion: 1,
      ignorable: false,
      decode: value => value as JsonObject,
    })
    const second = createDurableEventDefinition<JsonObject>({
      type: 'test/versioned',
      payloadVersion: 2,
      ignorable: true,
      decode: value => value as JsonObject,
    })
    const catalog = createDurableEventCatalog([first, second])

    expect(catalog.resolve(first.type, 1)).toBe(first)
    expect(catalog.resolve(first.type, 2)).toBe(second)
  })
})

describe('Session codecs and framing', () => {
  it('strictly round-trips canonical Header and Event JSON', () => {
    expect(decodeSessionHeader(encodeSessionHeader(header()))).toEqual(header())
    expect(decodeStoredSessionEvent(encodeStoredSessionEvent(event()))).toEqual(event())

    const invalidHeader = Buffer.from(JSON.stringify({ ...header(), extra: true }))
    expect(() => decodeSessionHeader(invalidHeader)).toThrowError(/unknown field extra/)
    const invalidEvent = Buffer.from(JSON.stringify({ ...event(), ignorable: false }))
    expect(() => decodeStoredSessionEvent(invalidEvent)).toThrowError(/absent or true/)

    const wrongSequence = Buffer.from(JSON.stringify({ ...event(), sequence: 2 }))
    expect(() => decodeStoredSessionEvent(wrongSequence)).toThrowError(/does not match/)
    const unsupportedHeader = Buffer.from(JSON.stringify({ ...header(), formatVersion: 2 }))
    expect(() => decodeSessionHeader(unsupportedHeader)).toThrowError(
      expect.objectContaining({ code: 'SESSION_FORMAT_UNSUPPORTED' }),
    )
    const unsupportedEnvelope = Buffer.from(JSON.stringify({ ...event(), envelopeVersion: 2 }))
    expect(() => decodeStoredSessionEvent(unsupportedEnvelope)).toThrowError(
      expect.objectContaining({ code: 'SESSION_ENVELOPE_UNSUPPORTED' }),
    )
    expect(() => decodeStoredSessionEvent(Uint8Array.from([0xff]))).toThrowError(/UTF-8 JSON/)
  })

  it('incrementally verifies frames and reports only valid physical EOF prefixes', () => {
    const payload = Buffer.from('{"value":3}')
    const frame = encodeFrame(payload, 1024)
    const scanner = new FrameScanner(1024)
    const frames = [
      ...scanner.push(frame.subarray(0, 5)),
      ...scanner.push(frame.subarray(5)),
    ]

    expect(Buffer.from(frames[0]?.payload ?? []).toString()).toBe('{"value":3}')
    expect(scanner.finish(false)).toEqual({ byteLength: frame.byteLength })

    const partial = new FrameScanner(1024)
    partial.push(frame.subarray(0, -1))
    expect(partial.finish(true)).toEqual({
      byteLength: 0,
      incompleteTail: { byteOffset: 0, byteLength: frame.byteLength - 1 },
    })
    expect(() => partial.finish(false)).toThrowError(/invalid suffix/)

    const badChecksum = Buffer.from(frame)
    const firstTab = badChecksum.indexOf(0x09)
    badChecksum[firstTab + 1] = badChecksum[firstTab + 1] === 0x30 ? 0x31 : 0x30
    expect(() => new FrameScanner(1024).push(badChecksum)).toThrowError(/checksum/)
  })

  it('rejects a complete payload with a mismatched physical checksum as a tail', () => {
    const payload = Buffer.from('{}')
    const checksum = createHash('sha256').update(Buffer.from('[]')).digest('hex')
    const noNewline = Buffer.from(`${payload.byteLength}\t${checksum}\t${payload.toString()}`)
    const scanner = new FrameScanner(128)
    scanner.push(noNewline)
    expect(() => scanner.finish(true)).toThrowError(/invalid suffix/)
  })

  it('recognizes interruption in every physical frame field', () => {
    const frame = encodeFrame(Buffer.from('{"message":"帧"}'), 1024)
    const firstTab = frame.indexOf(0x09)
    const secondTab = frame.indexOf(0x09, firstTab + 1)
    const cuts = [1, firstTab + 1, firstTab + 12, secondTab + 1, frame.byteLength - 2, frame.byteLength - 1]

    for (const cut of cuts) {
      const scanner = new FrameScanner(1024)
      scanner.push(frame.subarray(0, cut))
      expect(scanner.finish(true).incompleteTail?.byteLength).toBe(cut)
    }
  })

  it('uses UTF-8 byte length and fails on corruption after a valid middle frame', () => {
    const payload = Buffer.from('{"message":"中文"}')
    const first = encodeFrame(payload, 1024)
    const second = encodeFrame(Buffer.from('{}'), 1024)
    const corrupt = Buffer.concat([first, second])
    const secondStart = first.byteLength
    const checksumStart = corrupt.indexOf(0x09, secondStart) + 1
    corrupt[checksumStart] = corrupt[checksumStart] === 0x30 ? 0x31 : 0x30

    expect(Number(Buffer.from(first.subarray(0, first.indexOf(0x09))).toString('ascii'))).toBe(payload.byteLength)
    expect(() => new FrameScanner(1024).push(corrupt)).toThrowError(/checksum/)
  })
})

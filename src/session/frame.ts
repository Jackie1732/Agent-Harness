import { createHash } from 'node:crypto'
import { SessionError } from './errors.js'

const TAB = 0x09
const LF = 0x0a
const CHECKSUM_LENGTH = 64
const MAX_LENGTH_DIGITS = 16

/** One decoded frame and its byte range in the scanned stream. */
export interface DecodedFrame {
  readonly offset: number
  readonly endOffset: number
  readonly payload: Uint8Array
}

/** End-of-stream result from an incremental frame scan. */
export interface FrameScanEnd {
  readonly byteLength: number
  readonly incompleteTail?: {
    readonly byteOffset: number
    readonly byteLength: number
  }
}

function hash(payload: Uint8Array): string {
  return createHash('sha256').update(payload).digest('hex')
}

function invalid(message: string, offset: number): SessionError {
  return new SessionError('SESSION_LOG_INVALID', message, { details: { byteOffset: offset } })
}

/** Encode one JSON payload in the length/checksum/newline Session frame format. */
export function encodeFrame(payload: Uint8Array, maxRecordBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw new RangeError('maxRecordBytes must be a positive safe integer')
  }
  if (payload.byteLength > maxRecordBytes) {
    throw new SessionError('SESSION_RECORD_TOO_LARGE', 'Session record exceeds the configured byte limit', {
      details: { recordBytes: payload.byteLength, maxRecordBytes },
    })
  }
  const prefix = Buffer.from(`${payload.byteLength}\t${hash(payload)}\t`, 'ascii')
  return Buffer.concat([prefix, payload, Buffer.from('\n', 'ascii')])
}

function findByte(bytes: Uint8Array, value: number, from = 0): number {
  for (let index = from; index < bytes.byteLength; index += 1) {
    if (bytes[index] === value) return index
  }
  return -1
}

function ascii(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('ascii')
}

function parseLength(bytes: Uint8Array, absoluteOffset: number, maxRecordBytes: number): number {
  const text = ascii(bytes)
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw invalid('frame length is not canonical', absoluteOffset)
  const length = Number(text)
  if (!Number.isSafeInteger(length) || length > maxRecordBytes) {
    throw new SessionError('SESSION_RECORD_TOO_LARGE', 'Session frame declares an excessive record length', {
      details: { byteOffset: absoluteOffset, recordBytes: length, maxRecordBytes },
    })
  }
  return length
}

function validateChecksumText(bytes: Uint8Array, absoluteOffset: number): string {
  const text = ascii(bytes)
  if (!/^[0-9a-f]{64}$/.test(text)) throw invalid('frame checksum is not canonical SHA-256', absoluteOffset)
  return text
}

function isPhysicalFramePrefix(bytes: Uint8Array, maxRecordBytes: number): boolean {
  const firstTab = findByte(bytes, TAB)
  if (firstTab < 0) {
    const lengthText = ascii(bytes)
    const minimumLength = Number(lengthText)
    return bytes.byteLength > 0
      && bytes.byteLength <= MAX_LENGTH_DIGITS
      && /^[0-9]+$/.test(lengthText)
      && !(lengthText.length > 1 && lengthText.startsWith('0'))
      && Number.isSafeInteger(minimumLength)
      && minimumLength <= maxRecordBytes
  }
  if (firstTab === 0 || firstTab > MAX_LENGTH_DIGITS) return false
  let length: number
  try {
    length = parseLength(bytes.subarray(0, firstTab), 0, maxRecordBytes)
  } catch {
    return false
  }
  const secondTab = findByte(bytes, TAB, firstTab + 1)
  if (secondTab < 0) {
    const checksumPrefix = ascii(bytes.subarray(firstTab + 1))
    return checksumPrefix.length <= CHECKSUM_LENGTH && /^[0-9a-f]*$/.test(checksumPrefix)
  }
  if (secondTab - firstTab - 1 !== CHECKSUM_LENGTH) return false
  let expected: string
  try {
    expected = validateChecksumText(bytes.subarray(firstTab + 1, secondTab), firstTab + 1)
  } catch {
    return false
  }
  const body = bytes.subarray(secondTab + 1)
  if (body.byteLength < length) return true
  if (body.byteLength === length) return hash(body) === expected
  return false
}

/** Bounded incremental decoder for the Session frame stream. */
export class FrameScanner {
  readonly #maxRecordBytes: number
  #buffer = Buffer.alloc(0)
  #offset = 0

  constructor(maxRecordBytes: number) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
      throw new RangeError('maxRecordBytes must be a positive safe integer')
    }
    this.#maxRecordBytes = maxRecordBytes
  }

  /** Add bytes and return up to `frameLimit` complete verified frames. */
  push(chunk: Uint8Array, frameLimit = Number.POSITIVE_INFINITY): readonly DecodedFrame[] {
    if (frameLimit < 0 || !Number.isSafeInteger(frameLimit) && frameLimit !== Number.POSITIVE_INFINITY) {
      throw new RangeError('frameLimit must be a non-negative safe integer')
    }
    if (chunk.byteLength > 0) this.#buffer = Buffer.concat([this.#buffer, chunk])
    const frames: DecodedFrame[] = []
    while (this.#buffer.byteLength > 0 && frames.length < frameLimit) {
      const firstTab = findByte(this.#buffer, TAB)
      if (firstTab < 0) {
        if (this.#buffer.byteLength > MAX_LENGTH_DIGITS) {
          throw invalid('frame length prefix is too long', this.#offset)
        }
        break
      }
      if (firstTab === 0 || firstTab > MAX_LENGTH_DIGITS) {
        throw invalid('frame length prefix is invalid', this.#offset)
      }
      const length = parseLength(this.#buffer.subarray(0, firstTab), this.#offset, this.#maxRecordBytes)
      const secondTab = findByte(this.#buffer, TAB, firstTab + 1)
      if (secondTab < 0) {
        if (this.#buffer.byteLength - firstTab - 1 > CHECKSUM_LENGTH) {
          throw invalid('frame checksum prefix is too long', this.#offset + firstTab + 1)
        }
        break
      }
      if (secondTab - firstTab - 1 !== CHECKSUM_LENGTH) {
        throw invalid('frame checksum has the wrong length', this.#offset + firstTab + 1)
      }
      const expected = validateChecksumText(
        this.#buffer.subarray(firstTab + 1, secondTab),
        this.#offset + firstTab + 1,
      )
      const frameLength = secondTab + 1 + length + 1
      if (this.#buffer.byteLength < frameLength) break
      if (this.#buffer[frameLength - 1] !== LF) {
        throw invalid('frame is not terminated by LF', this.#offset + frameLength - 1)
      }
      const payload = this.#buffer.subarray(secondTab + 1, frameLength - 1)
      if (hash(payload) !== expected) {
        throw invalid('frame payload checksum does not match', this.#offset + secondTab + 1)
      }
      const start = this.#offset
      this.#offset += frameLength
      frames.push(Object.freeze({
        offset: start,
        endOffset: this.#offset,
        payload: Uint8Array.from(payload),
      }))
      this.#buffer = this.#buffer.subarray(frameLength)
    }
    return frames
  }

  /** Finish the stream, accepting only a syntactically valid interrupted-frame prefix. */
  finish(allowIncompleteTail: boolean): FrameScanEnd {
    if (this.#buffer.byteLength === 0) return Object.freeze({ byteLength: this.#offset })
    if (!allowIncompleteTail || !isPhysicalFramePrefix(this.#buffer, this.#maxRecordBytes)) {
      throw invalid('Session frame stream ends with an invalid suffix', this.#offset)
    }
    return Object.freeze({
      byteLength: this.#offset,
      incompleteTail: Object.freeze({ byteOffset: this.#offset, byteLength: this.#buffer.byteLength }),
    })
  }
}

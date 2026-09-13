import { TextDecoder } from 'node:util'
import { assertJsonValue } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { SessionError } from './errors.js'
import {
  formatSessionAddress,
  formatSessionEventId,
  parseSessionAddress,
  parseSessionEventId,
  parseSessionId,
  sessionLogPosition,
  sessionSequence,
} from './ids.js'
import { freezeDecodedJson, snapshotJson } from './json.js'
import { validateDurableEventType, validatePayloadVersion } from './event-catalog.js'
import {
  SESSION_ENVELOPE_VERSION,
  SESSION_FORMAT_VERSION,
} from './types.js'
import type { SessionHeader, StoredSessionEvent } from './types.js'

const utf8 = new TextDecoder('utf-8', { fatal: true })

function invalidLog(message: string, cause?: unknown): SessionError {
  return new SessionError('SESSION_LOG_INVALID', message, cause === undefined ? {} : { cause })
}

function parseJson(bytes: Uint8Array, label: string): JsonValue {
  try {
    const value: unknown = JSON.parse(utf8.decode(bytes))
    assertJsonValue(value, label)
    return freezeDecodedJson(value)
  } catch (cause) {
    throw invalidLog(`${label} is not valid UTF-8 JSON`, cause)
  }
}

function requireObject(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw invalidLog(`${label} must be a JSON object`)
  }
  return value as JsonObject
}

function requireExactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw invalidLog(`${label} is missing field ${key}`)
  }
  for (const key of keys) {
    if (!allowed.has(key)) throw invalidLog(`${label} contains unknown field ${key}`)
  }
}

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') throw invalidLog(`${label} must be a string`)
  return value
}

function requireNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number') throw invalidLog(`${label} must be a number`)
  return value
}

function requireTimestamp(value: JsonValue | undefined, label: string): string {
  const timestamp = requireString(value, label)
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== timestamp) {
    throw invalidLog(`${label} must be a canonical ISO timestamp`)
  }
  return timestamp
}

/** Encode a Session Header to its canonical JSON payload bytes. */
export function encodeSessionHeader(header: SessionHeader): Uint8Array {
  return Buffer.from(JSON.stringify(header), 'utf8')
}

/** Decode and strictly validate one Session Header JSON payload. */
export function decodeSessionHeader(bytes: Uint8Array): SessionHeader {
  const value = requireObject(parseJson(bytes, 'session header'), 'session header')
  requireExactKeys(
    value,
    ['formatVersion', 'sessionId', 'address', 'createdAt'],
    ['parent'],
    'session header',
  )
  const formatVersion = requireNumber(value.formatVersion, 'session header formatVersion')
  if (formatVersion !== SESSION_FORMAT_VERSION) {
    throw new SessionError('SESSION_FORMAT_UNSUPPORTED', `unsupported Session format ${formatVersion}`, {
      details: { formatVersion },
    })
  }
  const sessionId = parseSessionId(requireString(value.sessionId, 'session header sessionId'))
  const addressText = requireString(value.address, 'session header address')
  const addressSessionId = parseSessionAddress(addressText)
  if (addressSessionId !== sessionId || formatSessionAddress(sessionId) !== addressText) {
    throw invalidLog('session header address does not match its identity')
  }
  const createdAt = requireTimestamp(value.createdAt, 'session header createdAt')
  let parent: SessionHeader['parent']
  if (value.parent !== undefined) {
    const parentValue = requireObject(value.parent, 'session header parent')
    requireExactKeys(parentValue, ['sessionId', 'through'], [], 'session header parent')
    parent = Object.freeze({
      sessionId: parseSessionId(requireString(parentValue.sessionId, 'session header parent sessionId')),
      through: sessionLogPosition(requireNumber(parentValue.through, 'session header parent through')),
    })
    if (parent.sessionId === sessionId) throw invalidLog('session cannot name itself as parent')
  }
  return Object.freeze({
    formatVersion: SESSION_FORMAT_VERSION,
    sessionId,
    address: formatSessionAddress(sessionId),
    createdAt,
    ...(parent === undefined ? {} : { parent }),
  })
}

/** Encode one stored Session event to canonical JSON payload bytes. */
export function encodeStoredSessionEvent(event: StoredSessionEvent): Uint8Array {
  return Buffer.from(JSON.stringify(event), 'utf8')
}

/** Decode and strictly validate one stored Session event JSON payload. */
export function decodeStoredSessionEvent(bytes: Uint8Array): StoredSessionEvent {
  const value = requireObject(parseJson(bytes, 'session event'), 'session event')
  requireExactKeys(
    value,
    [
      'envelopeVersion',
      'sessionId',
      'eventId',
      'sequence',
      'recordedAt',
      'type',
      'payloadVersion',
      'payload',
    ],
    ['ignorable'],
    'session event',
  )
  const envelopeVersion = requireNumber(value.envelopeVersion, 'session event envelopeVersion')
  if (envelopeVersion !== SESSION_ENVELOPE_VERSION) {
    throw new SessionError('SESSION_ENVELOPE_UNSUPPORTED', `unsupported event envelope ${envelopeVersion}`, {
      details: { envelopeVersion },
    })
  }
  const sessionId = parseSessionId(requireString(value.sessionId, 'session event sessionId'))
  const sequence = sessionSequence(requireNumber(value.sequence, 'session event sequence'))
  const eventIdText = requireString(value.eventId, 'session event eventId')
  const parsedEventId = parseSessionEventId(eventIdText)
  if (
    parsedEventId.sessionId !== sessionId
    || parsedEventId.sequence !== sequence
    || formatSessionEventId(sessionId, sequence) !== eventIdText
  ) {
    throw invalidLog('session event identity does not match its Session and sequence')
  }
  const type = validateDurableEventType(requireString(value.type, 'session event type'))
  const payloadVersion = validatePayloadVersion(requireNumber(value.payloadVersion, 'session event payloadVersion'))
  if (value.ignorable !== undefined && value.ignorable !== true) {
    throw invalidLog('session event ignorable must be absent or true')
  }
  const payload = snapshotJson(value.payload, 'session event payload')
  return Object.freeze({
    envelopeVersion: SESSION_ENVELOPE_VERSION,
    sessionId,
    eventId: formatSessionEventId(sessionId, sequence),
    sequence,
    recordedAt: requireTimestamp(value.recordedAt, 'session event recordedAt'),
    type,
    payloadVersion,
    ...(value.ignorable === true ? { ignorable: true as const } : {}),
    payload,
  })
}

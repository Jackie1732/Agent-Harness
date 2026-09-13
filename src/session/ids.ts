import { randomUUID } from 'node:crypto'
import { brand } from '../foundation/brand.js'
import type { Brand } from '../foundation/brand.js'
import { SessionError } from './errors.js'

/** Stable identity of one durable Session. */
export type SessionId = Brand<string, 'SessionId'>

/** Logical address derived from a Session identity. */
export type SessionAddress = Brand<string, 'SessionAddress'>

/** Stable identity of one committed Session event. */
export type SessionEventId = Brand<string, 'SessionEventId'>

/** One-based local event sequence within a Session. */
export type SessionSequence = Brand<number, 'SessionSequence'>

/** Length of a committed local event prefix. */
export type SessionLogPosition = Brand<number, 'SessionLogPosition'>

/** Source of Session identities, injectable for deterministic tests. */
export interface SessionIdentitySource {
  /** @returns A new canonical Session identity. */
  nextSessionId(): SessionId
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SESSION_ADDRESS_PREFIX = 'ah-session:'
const EVENT_ID_PREFIX = 'ah-event:'

function invalidIdentifier(label: string, value: unknown): SessionError {
  return new SessionError(
    'SESSION_IDENTIFIER_INVALID',
    `${label} is not canonical`,
    { details: { label, value: typeof value === 'string' ? value : String(value) } },
  )
}

/** Parse and validate a canonical lower-case UUID Session identity. */
export function parseSessionId(value: string): SessionId {
  if (!UUID_PATTERN.test(value)) throw invalidIdentifier('session id', value)
  return brand<string, 'SessionId'>(value)
}

/** Derive the canonical logical address of a Session. */
export function formatSessionAddress(sessionId: SessionId): SessionAddress {
  return brand<string, 'SessionAddress'>(`${SESSION_ADDRESS_PREFIX}${sessionId}`)
}

/** Parse a canonical Session address and return the identity it contains. */
export function parseSessionAddress(value: string): SessionId {
  if (!value.startsWith(SESSION_ADDRESS_PREFIX)) throw invalidIdentifier('session address', value)
  const sessionId = parseSessionId(value.slice(SESSION_ADDRESS_PREFIX.length))
  if (formatSessionAddress(sessionId) !== value) throw invalidIdentifier('session address', value)
  return sessionId
}

/** Create a validated one-based local Session sequence. */
export function sessionSequence(value: number): SessionSequence {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SessionError('SESSION_POSITION_INVALID', 'session sequence must be a positive safe integer', {
      details: { kind: 'sequence', value },
    })
  }
  return brand<number, 'SessionSequence'>(value)
}

/** Create a validated local committed-prefix position. */
export function sessionLogPosition(value: number): SessionLogPosition {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new SessionError('SESSION_POSITION_INVALID', 'session log position must be a non-negative safe integer', {
      details: { kind: 'position', value },
    })
  }
  return brand<number, 'SessionLogPosition'>(value)
}

/** Derive the canonical identity of one local Session event. */
export function formatSessionEventId(
  sessionId: SessionId,
  sequence: SessionSequence,
): SessionEventId {
  return brand<string, 'SessionEventId'>(`${EVENT_ID_PREFIX}${sessionId}:${sequence}`)
}

/** Parse an event identity and return its Session identity and local sequence. */
export function parseSessionEventId(value: string): {
  readonly sessionId: SessionId
  readonly sequence: SessionSequence
} {
  if (!value.startsWith(EVENT_ID_PREFIX)) throw invalidIdentifier('session event id', value)
  const rest = value.slice(EVENT_ID_PREFIX.length)
  const separator = rest.lastIndexOf(':')
  if (separator < 0) throw invalidIdentifier('session event id', value)
  const sessionId = parseSessionId(rest.slice(0, separator))
  const sequenceText = rest.slice(separator + 1)
  if (!/^[1-9][0-9]*$/.test(sequenceText)) throw invalidIdentifier('session event id', value)
  let sequence: SessionSequence
  try {
    sequence = sessionSequence(Number(sequenceText))
  } catch {
    throw invalidIdentifier('session event id', value)
  }
  if (formatSessionEventId(sessionId, sequence) !== value) throw invalidIdentifier('session event id', value)
  return Object.freeze({ sessionId, sequence })
}

/** Cryptographically random production Session identity source. */
export const systemSessionIdentitySource: SessionIdentitySource = Object.freeze({
  nextSessionId: () => parseSessionId(randomUUID()),
})

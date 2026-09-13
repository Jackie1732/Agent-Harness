import type { JsonObject, JsonValue } from '../foundation/json.js'
import type {
  SessionAddress,
  SessionEventId,
  SessionId,
  SessionLogPosition,
  SessionSequence,
} from './ids.js'

/** Current physical Session format written by this release. */
export const SESSION_FORMAT_VERSION = 1 as const

/** Current stored event-envelope format written by this release. */
export const SESSION_ENVELOPE_VERSION = 1 as const

/** Maximum JSON byte length of the immutable Session Header record. */
export const SESSION_HEADER_MAX_BYTES = 4 * 1024

/** Immutable identity and lineage record of one Session. */
export interface SessionHeader {
  readonly formatVersion: typeof SESSION_FORMAT_VERSION
  readonly sessionId: SessionId
  readonly address: SessionAddress
  readonly createdAt: string
  readonly parent?: {
    readonly sessionId: SessionId
    readonly through: SessionLogPosition
  }
}

/** Durable, versioned event envelope stored in one local Session log. */
export interface StoredSessionEvent {
  readonly envelopeVersion: typeof SESSION_ENVELOPE_VERSION
  readonly sessionId: SessionId
  readonly eventId: SessionEventId
  readonly sequence: SessionSequence
  readonly recordedAt: string
  readonly type: string
  readonly payloadVersion: number
  readonly ignorable?: true
  readonly payload: JsonValue
}

/** Stored event paired with the Catalog-decoded immutable payload. */
export interface CommittedSessionEvent<TPayload extends JsonValue = JsonValue> {
  readonly kind: 'known'
  readonly stored: StoredSessionEvent
  readonly payload: TPayload
}

/** Unknown event retained because its envelope explicitly permits omission. */
export interface OpaqueSessionEvent {
  readonly kind: 'opaque'
  readonly stored: StoredSessionEvent
}

/** Semantically classified record retained in a Session Snapshot. */
export type SessionEventRecord = CommittedSessionEvent | OpaqueSessionEvent

/** Required payload of the built-in event that ends one local Session. */
export interface SessionEndedPayload extends JsonObject {
  readonly reason?: string
}

/** Lifecycle derived from a Session's own committed event prefix. */
export type SessionLifecycle = 'active' | 'ended'

/** Physical suffix excluded because it is a valid interrupted-frame prefix. */
export interface IncompleteSessionTail {
  readonly byteOffset: number
  readonly byteLength: number
}

/** One immutable local segment in root-to-target replay order. */
export interface SessionHistorySegment {
  readonly header: SessionHeader
  readonly through: SessionLogPosition
  readonly localLifecycle: SessionLifecycle
  readonly events: readonly SessionEventRecord[]
  readonly incompleteTail?: IncompleteSessionTail
}

/** Immutable read view of a Session and every inherited committed prefix. */
export interface SessionSnapshot {
  readonly header: SessionHeader
  readonly address: SessionAddress
  readonly lifecycle: SessionLifecycle
  readonly localPosition: SessionLogPosition
  readonly history: readonly SessionHistorySegment[]
}

/** Reference to an unknown ignorable event excluded from a Projection. */
export interface IgnoredSessionEvent {
  readonly sessionId: SessionId
  readonly eventId: SessionEventId
  readonly sequence: SessionSequence
  readonly type: string
  readonly payloadVersion: number
}

/** Coverage of the exact root-to-target prefixes consumed by a Projection. */
export interface SessionProjectionCoverage {
  readonly sessionId: SessionId
  readonly through: SessionLogPosition
}

/** Deterministic reducer over known durable Session events. */
export interface SessionProjection<TState extends JsonValue> {
  /** Stable diagnostic name included in projection failures. */
  readonly name: string
  /** Return the initial JSON state before replay begins. */
  readonly initial: (header: SessionHeader) => TState
  /** Reduce one known event into the next JSON state. */
  readonly apply: (state: TState, event: CommittedSessionEvent) => TState
}

/** Immutable result and coverage of one Projection replay. */
export interface SessionProjectionResult<TState extends JsonValue> {
  readonly state: TState
  readonly coverage: readonly SessionProjectionCoverage[]
  readonly ignoredEvents: readonly IgnoredSessionEvent[]
}

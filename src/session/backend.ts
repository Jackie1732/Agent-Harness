import type { IncompleteSessionTail, SessionHeader, StoredSessionEvent } from './types.js'
import type { SessionId, SessionLogPosition } from './ids.js'

/** Structurally verified local records returned by a Session Backend. */
export interface LocalStoredSession {
  readonly header: SessionHeader
  readonly events: readonly StoredSessionEvent[]
  readonly position: SessionLogPosition
  readonly incompleteTail?: IncompleteSessionTail
}

/** Exclusive append resource for one local Session log. */
export interface SessionWriter {
  readonly header: SessionHeader
  /** Read the currently committed local prefix. */
  readCommitted(): Promise<LocalStoredSession>
  /** Append and commit one event at the exact expected position. */
  append(
    expectedPosition: SessionLogPosition,
    event: StoredSessionEvent,
  ): Promise<SessionLogPosition>
  /** Release this process-local writer lease. */
  dispose(): Promise<void>
}

/** Physical storage interface below Catalog and lineage semantics. */
export interface SessionBackend {
  /** Atomically create one empty Session and its immutable Header. */
  create(header: SessionHeader): Promise<void>
  /** Acquire the sole process-local writer for one Session. */
  openWriter(sessionId: SessionId): Promise<SessionWriter>
  /** Read a structurally verified committed local prefix. */
  readPrefix(sessionId: SessionId, through?: SessionLogPosition): Promise<LocalStoredSession>
  /** Release Backend-owned resources and reject later work. */
  dispose(): Promise<void>
}

import { decodeSessionHeader, decodeStoredSessionEvent, encodeSessionHeader, encodeStoredSessionEvent } from './codec.js'
import type { LocalStoredSession, SessionBackend, SessionWriter } from './backend.js'
import { SessionError } from './errors.js'
import { encodeFrame } from './frame.js'
import { parseSessionId, sessionLogPosition } from './ids.js'
import type { SessionId, SessionLogPosition } from './ids.js'
import { SerialGate } from '../foundation/serial-gate.js'
import { SESSION_HEADER_MAX_BYTES } from './types.js'
import type { SessionHeader, StoredSessionEvent } from './types.js'

/** Configuration shared with the File Session Backend. */
export interface MemorySessionBackendOptions {
  readonly maxRecordBytes: number
}

interface MemorySessionRecord {
  readonly header: SessionHeader
  readonly events: StoredSessionEvent[]
  readonly gate: SerialGate
  writerToken: symbol | undefined
}

function copyHeader(header: SessionHeader): SessionHeader {
  return decodeSessionHeader(encodeSessionHeader(header))
}

function copyEvent(event: StoredSessionEvent): StoredSessionEvent {
  return decodeStoredSessionEvent(encodeStoredSessionEvent(event))
}

function notFound(sessionId: SessionId): SessionError {
  return new SessionError('SESSION_NOT_FOUND', `Session ${sessionId} does not exist`, {
    details: { sessionId },
  })
}

function ensureEventPosition(
  sessionId: SessionId,
  position: SessionLogPosition,
  event: StoredSessionEvent,
): void {
  const expectedSequence = position + 1
  if (event.sessionId !== sessionId || event.sequence !== expectedSequence) {
    throw new SessionError('SESSION_POSITION_CONFLICT', 'event does not extend the committed local prefix', {
      details: {
        sessionId,
        position,
        eventSessionId: event.sessionId,
        eventSequence: event.sequence,
      },
    })
  }
}

/** In-memory implementation of the durable Session Backend behavior contract. */
export class MemorySessionBackend implements SessionBackend {
  readonly #sessions = new Map<SessionId, MemorySessionRecord>()
  readonly #maxRecordBytes: number
  #active = true

  constructor(options: MemorySessionBackendOptions) {
    if (!Number.isSafeInteger(options.maxRecordBytes) || options.maxRecordBytes < 1) {
      throw new RangeError('maxRecordBytes must be a positive safe integer')
    }
    this.#maxRecordBytes = options.maxRecordBytes
  }

  async create(header: SessionHeader): Promise<void> {
    this.#assertActive()
    encodeFrame(encodeSessionHeader(header), SESSION_HEADER_MAX_BYTES)
    if (this.#sessions.has(header.sessionId)) {
      throw new SessionError('SESSION_ALREADY_EXISTS', `Session ${header.sessionId} already exists`, {
        details: { sessionId: header.sessionId },
      })
    }
    this.#sessions.set(header.sessionId, {
      header: copyHeader(header),
      events: [],
      gate: new SerialGate(),
      writerToken: undefined,
    })
  }

  async openWriter(sessionId: SessionId): Promise<SessionWriter> {
    this.#assertActive()
    parseSessionId(sessionId)
    const record = this.#sessions.get(sessionId)
    if (record === undefined) throw notFound(sessionId)
    const token = Symbol(String(sessionId))
    await record.gate.run(() => {
      this.#assertActive()
      if (record.writerToken !== undefined) {
        throw new SessionError('SESSION_WRITE_LEASED', `Session ${sessionId} already has a writer`, {
          details: { sessionId },
        })
      }
      record.writerToken = token
    })
    let active = true
    const assertWriter = (): void => {
      this.#assertActive()
      if (!active || record.writerToken !== token) {
        throw new SessionError('SESSION_HANDLE_INACTIVE', `writer for Session ${sessionId} is inactive`, {
          details: { sessionId },
        })
      }
    }
    return Object.freeze({
      header: record.header,
      readCommitted: async () => await record.gate.run(() => {
        assertWriter()
        return this.#snapshot(record)
      }),
      append: async (
        expectedPosition: SessionLogPosition,
        event: StoredSessionEvent,
      ) => await record.gate.run(() => {
        assertWriter()
        const position = sessionLogPosition(record.events.length)
        if (expectedPosition !== position) {
          throw new SessionError('SESSION_POSITION_CONFLICT', 'committed Session position changed', {
            details: { sessionId, expectedPosition, actualPosition: position },
          })
        }
        ensureEventPosition(sessionId, position, event)
        encodeFrame(encodeStoredSessionEvent(event), this.#maxRecordBytes)
        record.events.push(copyEvent(event))
        return sessionLogPosition(record.events.length)
      }),
      dispose: async () => {
        if (!active) return
        await record.gate.run(() => {
          if (record.writerToken === token) record.writerToken = undefined
          active = false
        })
      },
    })
  }

  async readPrefix(
    sessionId: SessionId,
    through?: SessionLogPosition,
  ): Promise<LocalStoredSession> {
    this.#assertActive()
    parseSessionId(sessionId)
    const record = this.#sessions.get(sessionId)
    if (record === undefined) throw notFound(sessionId)
    return await record.gate.run(() => {
      this.#assertActive()
      const available = sessionLogPosition(record.events.length)
      const position = through === undefined ? available : sessionLogPosition(through)
      if (position > available) {
        throw new SessionError('SESSION_POSITION_INVALID', 'requested prefix exceeds committed events', {
          details: { sessionId, through: position, available },
        })
      }
      return this.#snapshot(record, position)
    })
  }

  async dispose(): Promise<void> {
    if (!this.#active) return
    this.#active = false
    for (const record of this.#sessions.values()) record.writerToken = undefined
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new SessionError('SESSION_REPOSITORY_INACTIVE', 'Session Backend is disposed')
    }
  }

  #snapshot(
    record: MemorySessionRecord,
    position = sessionLogPosition(record.events.length),
  ): LocalStoredSession {
    const events = record.events.slice(0, position).map(copyEvent)
    return Object.freeze({
      header: record.header,
      events: Object.freeze(events),
      position,
    })
  }
}

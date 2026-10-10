import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'
import type { EffectLease } from '../effect/types.js'
import type { SessionWriter } from './backend.js'
import type { DurableEventCatalog, DurableEventDefinition } from './event-catalog.js'
import { sessionEndedEvent } from './event-catalog.js'
import { SessionError } from './errors.js'
import { extendLocalSegment, isSessionEndedRecord } from './history.js'
import { formatSessionEventId, sessionLogPosition, sessionSequence } from './ids.js'
import type { SessionLogPosition } from './ids.js'
import { projectSession } from './projection.js'
import { SESSION_ENVELOPE_VERSION } from './types.js'
import type {
  CommittedSessionEvent,
  SessionEndedPayload,
  SessionHeader,
  SessionHistorySegment,
  SessionProjection,
  SessionProjectionResult,
  SessionSnapshot,
  StoredSessionEvent,
} from './types.js'

/** Process-local state of an open Session Handle. */
export type SessionHandleStatus = 'open' | 'faulted' | 'disposed'

/** Writable, process-local view of one durable Session. */
export interface SessionHandle {
  readonly header: SessionHeader
  readonly status: SessionHandleStatus
  /** Actual Backend event-envelope byte ceiling; immutable for this Handle. */
  readonly maxRecordBytes: number
  /**
   * Append only if the queued operation still sees this local committed position.
   * A precondition failure is definitely unwritten and leaves the Handle healthy.
   */
  appendIfPosition<TPayload extends JsonValue>(
    expectedLocalPosition: SessionLogPosition,
    definition: DurableEventDefinition<TPayload>,
    payload: JsonValue,
  ): Promise<CommittedSessionEvent<TPayload>>
  /** Check exact Catalog ownership without exposing the Catalog itself. */
  supportsEventDefinition(definition: DurableEventDefinition): boolean
  /** Validate and append one Catalog-owned event; a terminal event closes write admission. */
  append<TPayload extends JsonValue>(definition: DurableEventDefinition<TPayload>, payload: JsonValue): Promise<CommittedSessionEvent<TPayload>>
  /** Append the built-in terminal event; concurrent calls share its result. */
  end(reason?: string): Promise<CommittedSessionEvent<SessionEndedPayload>>
  /** Return the Handle's immutable committed view without storage I/O. */
  snapshot(): SessionSnapshot
  /** Replay the current immutable view through one Projection. */
  project<TState extends JsonValue>(projection: SessionProjection<TState>): SessionProjectionResult<TState>
  /** Release the Writer after accepted work, retiring history while retaining header and Catalog queries. */
  dispose(): Promise<void>
}

/** Repository lifecycle operations used by a Handle. */
export interface SessionHandleOwner {
  assertActive(): void
  releaseHandle(handle: SessionHandleImpl): void
}

type AcceptanceStatus = 'accepting' | 'ending' | 'ended'

interface HandleRuntime {
  readonly owner: SessionHandleOwner
  readonly clock: Clock
  readonly writerLease: EffectLease<SessionWriter>
  view: SessionSnapshot
}

/** Build the frozen public view from a root-to-target history. */
export function freezeSessionSnapshot(history: readonly SessionHistorySegment[]): SessionSnapshot {
  const frozenHistory = Object.freeze([...history])
  const target = frozenHistory.at(-1)
  if (target === undefined) throw new Error('Session history must contain its target')
  return Object.freeze({
    header: target.header,
    address: target.header.address,
    lifecycle: target.localLifecycle,
    localPosition: target.through,
    history: frozenHistory,
  })
}

function eventInvalid(definition: DurableEventDefinition, cause: unknown): SessionError {
  return new SessionError('SESSION_EVENT_INVALID', 'durable event payload failed its definition', {
    details: { type: definition.type, payloadVersion: definition.payloadVersion },
    cause,
  })
}

/** Handle implementation that owns append order and one Effect-managed Writer lease. */
export class SessionHandleImpl implements SessionHandle {
  readonly #header: SessionHeader
  readonly #catalog: DurableEventCatalog
  readonly #maxRecordBytes: number
  #runtime: HandleRuntime | undefined
  #tail: Promise<void> = Promise.resolve()
  #status: SessionHandleStatus = 'open'
  #acceptance: AcceptanceStatus
  #disposeTask: Promise<void> | undefined
  #endingTask: Promise<CommittedSessionEvent<SessionEndedPayload>> | undefined
  #endedEvent: CommittedSessionEvent<SessionEndedPayload> | undefined

  constructor(
    owner: SessionHandleOwner,
    catalog: DurableEventCatalog,
    clock: Clock,
    writerLease: EffectLease<SessionWriter>,
    history: readonly SessionHistorySegment[],
    maxRecordBytes: number,
  ) {
    this.#maxRecordBytes = maxRecordBytes
    this.#catalog = catalog
    const view = freezeSessionSnapshot(history)
    this.#header = view.header
    this.#runtime = { owner, clock, writerLease, view }
    this.#acceptance = view.lifecycle === 'ended' ? 'ended' : 'accepting'
    if (this.#acceptance === 'ended') {
      const record = view.history.at(-1)?.events.at(-1)
      if (
        record?.kind !== 'known'
        || !isSessionEndedRecord(record.stored)
      ) {
        throw new Error('ended Session must finish with its terminal event')
      }
      this.#endedEvent = record as CommittedSessionEvent<SessionEndedPayload>
    }
  }

  get header(): SessionHeader {
    return this.#header
  }

  get status(): SessionHandleStatus {
    return this.#status
  }

  get maxRecordBytes(): number {
    return this.#maxRecordBytes
  }

  supportsEventDefinition(definition: DurableEventDefinition): boolean {
    return this.#catalog.contains(definition)
  }

  append<TPayload extends JsonValue>(
    definition: DurableEventDefinition<TPayload>,
    payload: JsonValue,
  ): Promise<CommittedSessionEvent<TPayload>> {
    this.#assertAppendable()
    return this.#prepareAndQueue(definition, payload)
  }

  appendIfPosition<TPayload extends JsonValue>(
    expectedLocalPosition: SessionLogPosition,
    definition: DurableEventDefinition<TPayload>,
    payload: JsonValue,
  ): Promise<CommittedSessionEvent<TPayload>> {
    this.#assertAppendable()
    const expected = sessionLogPosition(expectedLocalPosition)
    return this.#prepareAndQueue(definition, payload, expected)
  }

  #assertAppendable(): void {
    this.#assertWritable()
    if (this.#acceptance !== 'accepting') {
      throw new SessionError('SESSION_ENDED', `Session ${this.header.sessionId} is ending or ended`, {
        details: { sessionId: this.header.sessionId },
      })
    }
  }

  end(reason?: string): Promise<CommittedSessionEvent<SessionEndedPayload>> {
    this.#assertWritable()
    if (this.#endedEvent !== undefined) return Promise.resolve(this.#endedEvent)
    if (this.#endingTask !== undefined) return this.#endingTask
    return this.#prepareAndQueue(sessionEndedEvent, reason === undefined ? {} : { reason })
  }

  snapshot(): SessionSnapshot {
    if (this.#runtime === undefined) this.#inactive()
    return this.#runtime.view
  }

  project<TState extends JsonValue>(projection: SessionProjection<TState>): SessionProjectionResult<TState> {
    return projectSession(this.snapshot(), projection)
  }

  dispose(): Promise<void> {
    if (this.#disposeTask !== undefined) return this.#disposeTask
    const runtime = this.#runtime
    if (runtime === undefined) this.#inactive()
    const task = this.#tail.then(() => runtime.writerLease.dispose()).finally(() => {
      this.#status = 'disposed'
      runtime.owner.releaseHandle(this)
      this.#runtime = undefined
      this.#endingTask = undefined
      this.#endedEvent = undefined
    })
    this.#disposeTask = task
    return task
  }

  #assertWritable(): void {
    if (this.#runtime === undefined) this.#inactive()
    this.#runtime.owner.assertActive()
    if (this.#status !== 'open' || this.#disposeTask !== undefined) this.#inactive()
  }

  #inactive(): never {
    const state = this.#disposeTask !== undefined && this.#status === 'open' ? 'releasing' : this.#status
    throw new SessionError('SESSION_HANDLE_INACTIVE', `Session Handle ${this.header.sessionId} is ${state}`, {
      details: { sessionId: this.header.sessionId, status: state },
    })
  }

  #prepareAndQueue<TPayload extends JsonValue>(
    definition: DurableEventDefinition<TPayload>,
    payload: JsonValue,
    expectedPosition?: SessionLogPosition,
  ): Promise<CommittedSessionEvent<TPayload>> {
    if (!this.#catalog.contains(definition)) {
      throw new SessionError(
        'SESSION_EVENT_UNREGISTERED',
        `event definition ${definition.type}@${definition.payloadVersion} is not in this Repository`,
        { details: { type: definition.type, payloadVersion: definition.payloadVersion } },
      )
    }
    let decoded: TPayload
    try {
      const input = snapshotJson(payload, 'event payload')
      decoded = snapshotJson(definition.decode(input), 'decoded event payload') as TPayload
    } catch (cause) {
      throw eventInvalid(definition, cause)
    }
    const task = this.#tail.then(() => this.#commit(definition, decoded, expectedPosition))
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    )
    if (definition === sessionEndedEvent) {
      this.#acceptance = 'ending'
      this.#endingTask = task as Promise<CommittedSessionEvent<SessionEndedPayload>>
      void task.then(undefined, () => {
        if (this.#status === 'open') this.#acceptance = 'accepting'
        this.#endingTask = undefined
      })
    }
    return task
  }

  async #commit<TPayload extends JsonValue>(
    definition: DurableEventDefinition<TPayload>,
    payload: TPayload,
    expectedPosition?: SessionLogPosition,
  ): Promise<CommittedSessionEvent<TPayload>> {
    if (this.#status !== 'open') this.#inactive()
    const runtime = this.#runtime
    if (runtime === undefined) this.#inactive()
    if (runtime.view.lifecycle === 'ended') {
      throw new SessionError('SESSION_ENDED', `Session ${this.header.sessionId} is ended`, {
        details: { sessionId: this.header.sessionId },
      })
    }
    const position = runtime.view.localPosition
    if (expectedPosition !== undefined && expectedPosition !== position) {
      throw new SessionError('SESSION_PRECONDITION_FAILED', 'Session local prefix changed before conditional append', {
        details: { sessionId: this.header.sessionId, expectedPosition, actualPosition: position },
      })
    }
    const sequence = sessionSequence(position + 1)
    const stored: StoredSessionEvent = Object.freeze({
      envelopeVersion: SESSION_ENVELOPE_VERSION,
      sessionId: this.header.sessionId,
      eventId: formatSessionEventId(this.header.sessionId, sequence),
      sequence,
      recordedAt: clockTimestamp(runtime.clock),
      type: definition.type,
      payloadVersion: definition.payloadVersion,
      ...(definition.ignorable ? { ignorable: true as const } : {}),
      payload,
    })
    try {
      const committedPosition = await runtime.writerLease.value.append(position, stored)
      if (committedPosition !== position + 1) {
        throw new SessionError('SESSION_POSITION_CONFLICT', 'Backend returned an unexpected committed position', {
          details: { expectedPosition: position + 1, actualPosition: committedPosition },
        })
      }
    } catch (cause) {
      if (
        !(cause instanceof SessionError)
        || cause.code === 'SESSION_POSITION_CONFLICT'
        || cause.code === 'SESSION_APPEND_OUTCOME_UNKNOWN'
      ) this.#status = 'faulted'
      if (cause instanceof SessionError) throw cause
      throw new SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'Backend append outcome is unknown', {
        details: { sessionId: this.header.sessionId, sequence },
        cause,
      })
    }
    const event = Object.freeze({ kind: 'known' as const, stored, payload })
    const history = [...runtime.view.history]
    const target = history.at(-1)
    if (target === undefined) throw new Error('Session history must contain its target')
    history[history.length - 1] = extendLocalSegment(target, event)
    runtime.view = freezeSessionSnapshot(history)
    if (isSessionEndedRecord(stored)) {
      this.#endedEvent = event as CommittedSessionEvent<SessionEndedPayload>
      this.#acceptance = 'ended'
    }
    return event
  }
}

import type { Clock } from '../foundation/clock.js'
import { clockTimestamp, systemClock } from '../foundation/clock.js'
import { EffectOwner } from '../effect/owner.js'
import type { EffectLease } from '../effect/types.js'
import type { LocalStoredSession, SessionBackend, SessionWriter } from './backend.js'
import type { DurableEventCatalog } from './event-catalog.js'
import { SessionError } from './errors.js'
import {
  formatSessionAddress,
  parseSessionId,
  sessionLogPosition,
  systemSessionIdentitySource,
} from './ids.js'
import type { SessionId, SessionIdentitySource, SessionLogPosition } from './ids.js'
import { loadSessionHistory } from './lineage.js'
import {
  freezeSessionSnapshot,
  SessionHandleImpl,
} from './session-handle.js'
import type { SessionHandle, SessionHandleOwner } from './session-handle.js'
import { SESSION_FORMAT_VERSION } from './types.js'
import type { SessionHeader, SessionSnapshot } from './types.js'

/** Required construction inputs for a Session Repository. */
export interface SessionRepositoryOptions {
  readonly backend: SessionBackend
  readonly catalog: DurableEventCatalog
  readonly maxLineageDepth: number
  readonly clock?: Clock
  readonly identitySource?: SessionIdentitySource
}

type RepositoryStatus = 'active' | 'disposing' | 'disposed'

/** Durable Session repository that owns open Writers and semantic replay. */
export class SessionRepository implements SessionHandleOwner {
  readonly #backend: SessionBackend
  readonly #catalog: DurableEventCatalog
  readonly #maxLineageDepth: number
  readonly #clock: Clock
  readonly #identitySource: SessionIdentitySource
  readonly #owner = new EffectOwner('Session Repository')
  readonly #handles = new Set<SessionHandleImpl>()
  readonly #operations = new Set<Promise<unknown>>()
  #status: RepositoryStatus = 'active'
  #disposeTask: Promise<void> | undefined

  constructor(options: SessionRepositoryOptions) {
    if (!Number.isSafeInteger(options.maxLineageDepth) || options.maxLineageDepth < 0) {
      throw new RangeError('maxLineageDepth must be a non-negative safe integer')
    }
    this.#backend = options.backend
    this.#catalog = options.catalog
    this.#maxLineageDepth = options.maxLineageDepth
    this.#clock = options.clock ?? systemClock
    this.#identitySource = options.identitySource ?? systemSessionIdentitySource
  }

  /** Create a root Session and return its exclusive writable Handle. */
  async create(): Promise<SessionHandle> {
    this.assertActive()
    return await this.#track(this.#create())
  }

  async #create(): Promise<SessionHandle> {
    const sessionId = parseSessionId(this.#identitySource.nextSessionId())
    const header: SessionHeader = Object.freeze({
      formatVersion: SESSION_FORMAT_VERSION,
      sessionId,
      address: formatSessionAddress(sessionId),
      createdAt: clockTimestamp(this.#clock),
    })
    await this.#backend.create(header)
    return await this.#openHeader(header)
  }

  /** Open an existing Session with its exclusive process-local Writer. */
  async open(sessionId: SessionId): Promise<SessionHandle> {
    this.assertActive()
    parseSessionId(sessionId)
    return await this.#track(this.#open(sessionId))
  }

  async #open(sessionId: SessionId): Promise<SessionHandle> {
    const writerLease = await this.#acquireWriter(sessionId)
    try {
      return await this.#finishOpen(writerLease, await writerLease.value.readCommitted())
    } catch (cause) {
      await writerLease.dispose()
      throw cause
    }
  }

  /** Read one immutable Session view without retaining a Writer. */
  async read(sessionId: SessionId): Promise<SessionSnapshot> {
    this.assertActive()
    parseSessionId(sessionId)
    return await this.#track(this.#read(sessionId))
  }

  async #read(sessionId: SessionId): Promise<SessionSnapshot> {
    const local = await this.#backend.readPrefix(sessionId)
    return freezeSessionSnapshot(await this.#loadHistory(local))
  }

  /** Create a child whose history inherits one committed local source prefix. */
  async fork(source: SessionId, through?: SessionLogPosition): Promise<SessionHandle> {
    this.assertActive()
    parseSessionId(source)
    const requested = through === undefined ? undefined : sessionLogPosition(through)
    return await this.#track(this.#fork(source, requested))
  }

  async #fork(source: SessionId, through?: SessionLogPosition): Promise<SessionHandle> {
    const sourceHistory = await this.#loadHistory(await this.#backend.readPrefix(source, through))
    if (sourceHistory.length > this.#maxLineageDepth) {
      throw new SessionError('SESSION_LINEAGE_LIMIT', 'fork would exceed its configured lineage depth', {
        details: { sourceSessionId: source, maxLineageDepth: this.#maxLineageDepth },
      })
    }
    const sourceTarget = sourceHistory.at(-1)
    if (sourceTarget === undefined) throw new Error('source history must contain its target')
    const sessionId = parseSessionId(this.#identitySource.nextSessionId())
    const header: SessionHeader = Object.freeze({
      formatVersion: SESSION_FORMAT_VERSION,
      sessionId,
      address: formatSessionAddress(sessionId),
      createdAt: clockTimestamp(this.#clock),
      parent: Object.freeze({ sessionId: source, through: sourceTarget.through }),
    })
    await this.#backend.create(header)
    return await this.#openHeader(header)
  }

  /** Release every accepted Handle and the owned Backend. */
  dispose(): Promise<void> {
    if (this.#disposeTask !== undefined) return this.#disposeTask
    this.#status = 'disposing'
    const task = (async () => {
      await Promise.allSettled([...this.#operations])
      const handleResults = await Promise.allSettled([...this.#handles].map(handle => handle.dispose()))
      const failures = handleResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason)
      try {
        await this.#owner.dispose()
      } catch (cause) {
        failures.push(cause)
      }
      try {
        await this.#backend.dispose()
      } catch (cause) {
        failures.push(cause)
      }
      this.#status = 'disposed'
      if (failures.length > 0) throw new AggregateError(failures, 'Session Repository disposal failed')
    })()
    this.#disposeTask = task
    return task
  }

  /** Reject work once Repository disposal starts. */
  assertActive(): void {
    if (this.#status !== 'active') {
      throw new SessionError('SESSION_REPOSITORY_INACTIVE', `Session Repository is ${this.#status}`, {
        details: { status: this.#status },
      })
    }
  }

  /** Forget one Handle after its Writer lease has settled. */
  releaseHandle(handle: SessionHandleImpl): void {
    this.#handles.delete(handle)
  }

  async #openHeader(header: SessionHeader): Promise<SessionHandle> {
    const writerLease = await this.#acquireWriter(header.sessionId)
    try {
      const local = await writerLease.value.readCommitted()
      if (local.header.sessionId !== header.sessionId) {
        throw new SessionError('SESSION_LOG_INVALID', 'created Session reopened with a different identity')
      }
      return await this.#finishOpen(writerLease, local)
    } catch (cause) {
      await writerLease.dispose()
      throw cause
    }
  }

  async #acquireWriter(sessionId: SessionId): Promise<EffectLease<SessionWriter>> {
    return await this.#owner.run(`Session writer ${sessionId}`, async effect => {
      return await effect.apply(
        'open Session writer',
        () => this.#backend.openWriter(sessionId),
        writer => writer.dispose(),
      )
    })
  }

  async #finishOpen(
    writerLease: EffectLease<SessionWriter>,
    local: LocalStoredSession,
  ): Promise<SessionHandle> {
    const history = await this.#loadHistory(local)
    const handle = new SessionHandleImpl(this, this.#catalog, this.#clock, writerLease, history)
    this.#handles.add(handle)
    return handle
  }

  async #loadHistory(target: LocalStoredSession) {
    return await loadSessionHistory(
      this.#backend,
      this.#catalog,
      target,
      this.#maxLineageDepth,
    )
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation)
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation),
    )
    return operation
  }
}

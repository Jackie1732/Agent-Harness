import type { FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { LocalStoredSession, SessionBackend, SessionWriter } from './backend.js'
import {
  decodeSessionHeader,
  decodeStoredSessionEvent,
  encodeSessionHeader,
  encodeStoredSessionEvent,
} from './codec.js'
import { SessionError } from './errors.js'
import {
  createFileSession,
  fileSessionLog,
  fileSessionLogSize,
  openFileSessionLog,
  prepareFileRoot,
  readFileSessionHeader,
  scanFileSessionEvents,
  validateFileSessionEvents,
  writeAll,
} from './file-store.js'
import type { PreparedFileRoot } from './file-store.js'
import { encodeFrame } from './frame.js'
import { sessionLogPosition } from './ids.js'
import type { SessionId, SessionLogPosition } from './ids.js'
import { SerialGate } from '../foundation/serial-gate.js'
import type { SessionHeader, StoredSessionEvent } from './types.js'

/** Explicit configuration of a local File Session Backend. */
export interface FileSessionBackendOptions {
  readonly root: string
  readonly maxRecordBytes: number
}

/** File append operations replaced only by deterministic internal tests. */
export interface FileAppendOperations {
  readonly writeAll: (handle: FileHandle, bytes: Uint8Array, position: number) => Promise<void>
  readonly sync: (handle: FileHandle) => Promise<void>
}

const systemAppendOperations: FileAppendOperations = Object.freeze({
  writeAll,
  sync: async (handle: FileHandle) => await handle.sync(),
})

const injectedAppendOperations = new WeakMap<FileSessionBackendOptions, FileAppendOperations>()

/** Construct a File Backend with narrow append fault controls for internal tests. */
export function createFileSessionBackendForTest(
  options: FileSessionBackendOptions,
  operations: FileAppendOperations,
): FileSessionBackend {
  injectedAppendOperations.set(options, operations)
  return new FileSessionBackend(options)
}

interface FileCommitState {
  readonly gate: SerialGate
  references: number
  writerToken: symbol | undefined
  committedBytes: number | undefined
  position: SessionLogPosition | undefined
  unknown: boolean
}

const commitStates = new Map<string, FileCommitState>()

function stateKey(root: PreparedFileRoot, sessionId: SessionId): string {
  return `${root.root}\u0000${sessionId}`
}

function acquireCommitState(root: PreparedFileRoot, sessionId: SessionId): FileCommitState {
  const key = stateKey(root, sessionId)
  let state = commitStates.get(key)
  if (state === undefined) {
    state = {
      gate: new SerialGate(),
      references: 0,
      writerToken: undefined,
      committedBytes: undefined,
      position: undefined,
      unknown: false,
    }
    commitStates.set(key, state)
  }
  state.references += 1
  return state
}

function releaseCommitState(
  root: PreparedFileRoot,
  sessionId: SessionId,
  state: FileCommitState,
): void {
  state.references -= 1
  if (state.references === 0 && state.writerToken === undefined) {
    const key = stateKey(root, sessionId)
    if (commitStates.get(key) === state) commitStates.delete(key)
  }
}

/** Local disk Backend with framed files and process-global writer coordination. */
export class FileSessionBackend implements SessionBackend {
  readonly #rootInput: string
  #ready: Promise<PreparedFileRoot> | undefined
  readonly #maxRecordBytes: number
  readonly #appendOperations: FileAppendOperations
  readonly #writerDisposers = new Set<() => Promise<void>>()
  #active = true
  #disposeTask: Promise<void> | undefined

  constructor(options: FileSessionBackendOptions) {
    if (!Number.isSafeInteger(options.maxRecordBytes) || options.maxRecordBytes < 1) {
      throw new RangeError('maxRecordBytes must be a positive safe integer')
    }
    if (!isAbsolute(options.root)) throw new TypeError('File Session root must be absolute')
    this.#rootInput = options.root
    this.#maxRecordBytes = options.maxRecordBytes
    this.#appendOperations = injectedAppendOperations.get(options) ?? systemAppendOperations
    injectedAppendOperations.delete(options)
  }

  /** The same byte ceiling used by the physical record encoder. */
  get maxRecordBytes(): number {
    return this.#maxRecordBytes
  }

  async create(headerInput: SessionHeader): Promise<void> {
    this.#assertActive()
    const header = decodeSessionHeader(encodeSessionHeader(headerInput))
    const root = await this.#getRoot()
    this.#assertActive()
    await createFileSession(root, header)
  }

  async openWriter(
    sessionId: SessionId,
    validateCommitted?: (local: LocalStoredSession) => void | Promise<void>,
  ): Promise<SessionWriter> {
    this.#assertActive()
    const root = await this.#getRoot()
    this.#assertActive()
    const header = await readFileSessionHeader(root, sessionId)
    const path = fileSessionLog(root, sessionId)
    const state = acquireCommitState(root, sessionId)
    const token = Symbol(String(sessionId))
    let acquired: { readonly handle: FileHandle; readonly local: LocalStoredSession }
    try {
      acquired = await state.gate.run(async () => {
        this.#assertActive()
        if (state.writerToken !== undefined) {
          throw new SessionError('SESSION_WRITE_LEASED', `Session ${sessionId} already has a writer`, {
            details: { sessionId },
          })
        }
        state.writerToken = token
        state.unknown = false
        try {
          const opened = await openFileSessionLog(path)
          try {
            const scanned = await scanFileSessionEvents(
              path,
              (await opened.stat()).size,
              this.#maxRecordBytes,
            )
            validateFileSessionEvents(sessionId, scanned.events)
            state.committedBytes = scanned.committedBytes
            state.position = scanned.position
            return {
              handle: opened,
              local: Object.freeze({
                header,
                events: scanned.events,
                position: scanned.position,
                ...(scanned.incompleteTail === undefined ? {} : { incompleteTail: scanned.incompleteTail }),
              }),
            }
          } catch (cause) {
            await opened.close()
            throw cause
          }
        } catch (cause) {
          this.#clearWriterState(state)
          throw cause
        }
      })
    } catch (cause) {
      releaseCommitState(root, sessionId, state)
      throw cause
    }
    const { handle, local } = acquired
    let writerActive = true
    let writerDisposal: Promise<void> | undefined
    const assertWriter = (): void => {
      this.#assertActive()
      if (!writerActive || state.writerToken !== token) {
        throw new SessionError('SESSION_HANDLE_INACTIVE', `writer for Session ${sessionId} is inactive`, {
          details: { sessionId },
        })
      }
    }
    const disposeWriter = (): Promise<void> => {
      writerDisposal ??= state.gate.run(async () => {
        writerActive = false
        let failure: unknown
        try {
          await handle.close()
        } catch (cause) {
          failure = cause
        } finally {
          if (state.writerToken === token) this.#clearWriterState(state)
          releaseCommitState(root, sessionId, state)
          this.#writerDisposers.delete(disposeWriter)
        }
        if (failure !== undefined) throw failure
      })
      return writerDisposal
    }
    this.#writerDisposers.add(disposeWriter)
    try {
      assertWriter()
      if (validateCommitted !== undefined) await validateCommitted(local)
      if (local.incompleteTail !== undefined) {
        const committedBytes = local.incompleteTail.byteOffset
        await state.gate.run(async () => {
          assertWriter()
          await handle.truncate(committedBytes)
          await handle.sync()
        })
      }
      assertWriter()
      return this.#createWriter(
        sessionId,
        header,
        path,
        handle,
        state,
        assertWriter,
        disposeWriter,
      )
    } catch (cause) {
      try {
        await disposeWriter()
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'File Writer admission and release failed', { cause })
      }
      throw cause
    }
  }

  async readPrefix(
    sessionId: SessionId,
    through?: SessionLogPosition,
  ): Promise<LocalStoredSession> {
    this.#assertActive()
    const root = await this.#getRoot()
    this.#assertActive()
    const header = await readFileSessionHeader(root, sessionId)
    const path = fileSessionLog(root, sessionId)
    const state = acquireCommitState(root, sessionId)
    try {
      return await this.#readStored(header, path, state, () => this.#assertActive(), through)
    } finally {
      releaseCommitState(root, sessionId, state)
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposeTask !== undefined) return this.#disposeTask
    this.#active = false
    const task = (async () => {
      const results = await Promise.allSettled([...this.#writerDisposers].map(dispose => dispose()))
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'File Session Backend disposal failed')
    })()
    this.#disposeTask = task
    return task
  }

  #createWriter(
    sessionId: SessionId,
    header: SessionHeader,
    path: string,
    handle: FileHandle,
    state: FileCommitState,
    assertWriter: () => void,
    disposeWriter: () => Promise<void>,
  ): SessionWriter {
    return Object.freeze({
      header,
      readCommitted: async () => {
        assertWriter()
        return await this.#readStored(header, path, state, assertWriter)
      },
      append: async (expectedPosition: SessionLogPosition, event: StoredSessionEvent) => {
        assertWriter()
        const canonical = decodeStoredSessionEvent(encodeStoredSessionEvent(event))
        const frame = encodeFrame(encodeStoredSessionEvent(canonical), this.#maxRecordBytes)
        return await state.gate.run(async () => {
          assertWriter()
          if (state.unknown) {
            throw new SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'previous append outcome is unknown', {
              details: { sessionId },
            })
          }
          const position = state.position
          const committedBytes = state.committedBytes
          if (position === undefined || committedBytes === undefined) {
            throw new Error('active File writer has no committed boundary')
          }
          if (
            expectedPosition !== position
            || canonical.sessionId !== sessionId
            || canonical.sequence !== position + 1
          ) {
            throw new SessionError('SESSION_POSITION_CONFLICT', 'event does not extend the committed local prefix', {
              details: {
                sessionId,
                expectedPosition,
                actualPosition: position,
                eventSequence: canonical.sequence,
              },
            })
          }
          try {
            await this.#appendOperations.writeAll(handle, frame, committedBytes)
            await this.#appendOperations.sync(handle)
          } catch (cause) {
            state.unknown = true
            throw new SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'File append outcome is unknown', {
              details: { sessionId, sequence: canonical.sequence },
              cause,
            })
          }
          state.committedBytes = committedBytes + frame.byteLength
          state.position = sessionLogPosition(position + 1)
          return state.position
        })
      },
      dispose: disposeWriter,
    })
  }

  async #readStored(
    header: SessionHeader,
    path: string,
    state: FileCommitState,
    assertAccess: () => void,
    through?: SessionLogPosition,
  ): Promise<LocalStoredSession> {
    const sessionId = header.sessionId
    const requested = through === undefined ? undefined : sessionLogPosition(through)
    const capture = await state.gate.run(async () => {
      assertAccess()
      if (state.writerToken !== undefined) {
        if (state.unknown) {
          throw new SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'File Session commit boundary is unknown', {
            details: { sessionId },
          })
        }
        if (state.committedBytes === undefined) throw new Error('active File writer has no committed boundary')
        return { kind: 'boundary', value: state.committedBytes } as const
      }
      const boundary = await fileSessionLogSize(path, sessionId)
      // Finish an idle-log scan before a newly admitted Writer can repair its tail.
      const scanned = await scanFileSessionEvents(path, boundary, this.#maxRecordBytes, requested)
      return { kind: 'scanned', value: scanned } as const
    })
    const scanned = capture.kind === 'scanned'
      ? capture.value
      : await scanFileSessionEvents(path, capture.value, this.#maxRecordBytes, requested)
    validateFileSessionEvents(sessionId, scanned.events)
    return Object.freeze({
      header,
      events: scanned.events,
      position: scanned.position,
      ...(scanned.incompleteTail === undefined ? {} : { incompleteTail: scanned.incompleteTail }),
    })
  }

  #clearWriterState(state: FileCommitState): void {
    state.writerToken = undefined
    state.committedBytes = undefined
    state.position = undefined
    state.unknown = false
  }

  #getRoot(): Promise<PreparedFileRoot> {
    this.#ready ??= prepareFileRoot(this.#rootInput)
    return this.#ready
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new SessionError('SESSION_REPOSITORY_INACTIVE', 'File Session Backend is disposed')
    }
  }
}

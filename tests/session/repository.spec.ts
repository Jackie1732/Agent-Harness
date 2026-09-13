import { describe, expect, it } from 'vitest'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'
import {
  CapabilityRegistry,
  createDurableEventCatalog,
  createDurableEventDefinition,
  createSessionRepositoryComponent,
  formatSessionAddress,
  formatSessionEventId,
  MemorySessionBackend,
  parseSessionId,
  sessionLogPosition,
  sessionSequence,
  SessionError,
  SessionRepository,
  SessionRepositoryKey,
  sessionEndedEvent,
} from '../../src/index.js'
import type {
  CommittedSessionEvent,
  JsonObject,
  JsonValue,
  SessionIdentitySource,
  SessionBackend,
  SessionHeader,
  SessionId,
  SessionProjection,
  SessionWriter,
  StoredSessionEvent,
} from '../../src/index.js'

interface Delta extends JsonObject {
  readonly value: number
}

function deltaDecoder(value: JsonValue): Delta {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('delta must be an object')
  }
  const object = value as JsonObject
  if (Object.keys(object).length !== 1 || typeof object.value !== 'number') {
    throw new TypeError('delta.value must be the only numeric field')
  }
  return { value: object.value }
}

const deltaEvent = createDurableEventDefinition<Delta>({
  type: 'test/delta',
  payloadVersion: 1,
  ignorable: false,
  decode: deltaDecoder,
})

function identities(...values: readonly string[]): SessionIdentitySource {
  let index = 0
  return {
    nextSessionId: () => {
      const value = values[index]
      if (value === undefined) throw new Error('identity fixture exhausted')
      index += 1
      return parseSessionId(value)
    },
  }
}

const firstId = '00000000-0000-4000-8000-000000000011'
const secondId = '00000000-0000-4000-8000-000000000012'

function repository(identitySource = identities(firstId, secondId)): SessionRepository {
  return new SessionRepository({
    backend: new MemorySessionBackend({ maxRecordBytes: 4096 }),
    catalog: createDurableEventCatalog([deltaEvent]),
    maxLineageDepth: 4,
    clock: { now: () => 1_789_257_600_000 },
    identitySource,
  })
}

const sumProjection: SessionProjection<number> = Object.freeze({
  name: 'sum',
  initial: () => 0,
  apply: (state: number, event: CommittedSessionEvent) => state + (event.stored.type === deltaEvent.type
    ? (event.payload as Delta).value
    : 0),
})

describe('Session Repository and Handle', () => {
  it('serializes accepted appends, snapshots payloads, and ends independently of disposal', async () => {
    const repo = repository()
    const handle = await repo.create()
    const mutable = { value: 2 }
    const first = handle.append(deltaEvent, mutable)
    mutable.value = 100
    const second = handle.append(deltaEvent, { value: 3 })

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { stored: { sequence: 1 }, payload: { value: 2 } },
      { stored: { sequence: 2 }, payload: { value: 3 } },
    ])
    expect(handle.project(sumProjection).state).toBe(5)
    const ended = await handle.end('complete')
    expect(ended.stored.sequence).toBe(3)
    expect((await handle.end()).stored.eventId).toBe(ended.stored.eventId)
    expect(handle.snapshot().lifecycle).toBe('ended')
    expect(() => handle.append(deltaEvent, { value: 1 })).toThrowError(
      expect.objectContaining({ code: 'SESSION_ENDED' }),
    )
    expect(handle.status).toBe('open')
    await handle.dispose()
    expect(handle.status).toBe('disposed')
    await repo.dispose()
  })

  it('orders end after accepted appends and rejects new appends at the ending acceptance point', async () => {
    const inner = new MemorySessionBackend({ maxRecordBytes: 4096 })
    const appendStarted = createDeferred<void>()
    const releaseAppend = createDeferred<void>()
    let firstAppend = true
    const backend: SessionBackend = {
      create: header => inner.create(header),
      openWriter: async sessionId => {
        const writer = await inner.openWriter(sessionId)
        return {
          header: writer.header,
          readCommitted: () => writer.readCommitted(),
          append: async (position, stored) => {
            if (firstAppend) {
              firstAppend = false
              appendStarted.resolve(undefined)
              await releaseAppend.promise
            }
            return await writer.append(position, stored)
          },
          dispose: () => writer.dispose(),
        }
      },
      readPrefix: (sessionId, through) => inner.readPrefix(sessionId, through),
      dispose: () => inner.dispose(),
    }
    const repo = new SessionRepository({
      backend,
      catalog: createDurableEventCatalog([deltaEvent]),
      maxLineageDepth: 1,
      identitySource: identities(firstId),
    })
    const handle = await repo.create()
    const append = handle.append(deltaEvent, { value: 1 })
    await appendStarted.promise
    const ending = handle.end()

    expect(() => handle.append(deltaEvent, { value: 2 })).toThrowError(
      expect.objectContaining({ code: 'SESSION_ENDED' }),
    )
    releaseAppend.resolve(undefined)
    await expect(Promise.all([append, ending])).resolves.toMatchObject([
      { stored: { sequence: 1 } },
      { stored: { sequence: 2, type: 'session/ended' } },
    ])
    await repo.dispose()
  })

  it('waits for an accepted Repository read before releasing Handles and Backend', async () => {
    const inner = new MemorySessionBackend({ maxRecordBytes: 4096 })
    const readStarted = createDeferred<void>()
    const releaseRead = createDeferred<void>()
    let blockReads = false
    let backendDisposed = false
    const backend: SessionBackend = {
      create: header => inner.create(header),
      openWriter: sessionId => inner.openWriter(sessionId),
      readPrefix: async (sessionId, through) => {
        if (blockReads) {
          readStarted.resolve(undefined)
          await releaseRead.promise
        }
        return await inner.readPrefix(sessionId, through)
      },
      dispose: async () => {
        backendDisposed = true
        await inner.dispose()
      },
    }
    const repo = new SessionRepository({
      backend,
      catalog: createDurableEventCatalog(),
      maxLineageDepth: 1,
      identitySource: identities(firstId),
    })
    const handle = await repo.create()
    blockReads = true
    const read = repo.read(handle.header.sessionId)
    await readStarted.promise
    let disposalSettled = false
    const disposal = repo.dispose().finally(() => {
      disposalSettled = true
    })
    await drainMicrotasks()

    expect(disposalSettled).toBe(false)
    expect(backendDisposed).toBe(false)
    releaseRead.resolve(undefined)
    await read
    await disposal
    expect(backendDisposed).toBe(true)
  })

  it('enforces Catalog object identity and leaves the Handle usable after invalid input', async () => {
    const repo = repository()
    const handle = await repo.create()
    const impostor = createDurableEventDefinition<Delta>({
      type: deltaEvent.type,
      payloadVersion: deltaEvent.payloadVersion,
      ignorable: false,
      decode: deltaDecoder,
    })

    expect(() => handle.append(impostor, { value: 1 })).toThrowError(
      expect.objectContaining({ code: 'SESSION_EVENT_UNREGISTERED' }),
    )
    expect(() => handle.append(deltaEvent, { value: 'wrong' })).toThrowError(
      expect.objectContaining({ code: 'SESSION_EVENT_INVALID' }),
    )
    await expect(handle.append(deltaEvent, { value: 4 })).resolves.toMatchObject({
      stored: { sequence: 1 },
    })
    await repo.dispose()
  })

  it('contains Projection mutation failures without changing the log or Writer', async () => {
    const repo = repository()
    const handle = await repo.create()
    const committed = await handle.append(deltaEvent, { value: 2 })
    const mutatingProjection: SessionProjection<JsonObject> = {
      name: 'mutating',
      initial: () => ({ count: 0 }),
      apply: state => {
        ;(state as { count: number }).count += 1
        return state
      },
    }

    expect(() => handle.project(mutatingProjection)).toThrowError(
      expect.objectContaining({
        code: 'SESSION_PROJECTION_FAILED',
        details: { projection: 'mutating', sessionId: handle.header.sessionId, eventId: committed.stored.eventId },
      }),
    )
    expect(handle.status).toBe('open')
    expect(handle.snapshot().localPosition).toBe(1)
    await expect(handle.append(deltaEvent, { value: 3 })).resolves.toMatchObject({
      stored: { sequence: 2 },
    })
    await repo.dispose()
  })

  it('produces equal replay output from fresh Projection instances', async () => {
    const repo = repository()
    const handle = await repo.create()
    await handle.append(deltaEvent, { value: 2 })
    await handle.append(deltaEvent, { value: 3 })
    const projection = (): SessionProjection<number> => ({
      name: 'fresh sum',
      initial: () => 0,
      apply: (state, event) => state + (event.stored.type === deltaEvent.type
        ? (event.payload as Delta).value
        : 0),
    })

    expect(handle.project(projection())).toEqual(handle.project(projection()))
    await repo.dispose()
  })

  it('keeps a child on its captured parent prefix and does not inherit parent termination', async () => {
    const repo = repository()
    const parent = await repo.create()
    await parent.append(deltaEvent, { value: 2 })
    const child = await repo.fork(parent.header.sessionId)
    await parent.append(deltaEvent, { value: 20 })
    await parent.end()
    await child.append(deltaEvent, { value: 3 })

    const snapshot = child.snapshot()
    expect(snapshot.history).toHaveLength(2)
    expect(snapshot.history[0]?.events).toHaveLength(1)
    expect(snapshot.history[1]?.events).toHaveLength(1)
    expect(snapshot.lifecycle).toBe('active')
    expect(child.project(sumProjection).state).toBe(5)
    await repo.dispose()
  })

  it('supports zero, middle, latest, and nested local fork cuts', async () => {
    const repo = repository(identities(
      firstId,
      secondId,
      '00000000-0000-4000-8000-000000000013',
      '00000000-0000-4000-8000-000000000014',
      '00000000-0000-4000-8000-000000000015',
    ))
    const parent = await repo.create()
    await parent.append(deltaEvent, { value: 1 })
    await parent.append(deltaEvent, { value: 2 })
    const zero = await repo.fork(parent.header.sessionId, sessionLogPosition(0))
    const middle = await repo.fork(parent.header.sessionId, sessionLogPosition(1))
    const latest = await repo.fork(parent.header.sessionId)
    await parent.append(deltaEvent, { value: 100 })
    await middle.append(deltaEvent, { value: 10 })
    const nested = await repo.fork(middle.header.sessionId)

    expect(zero.project(sumProjection).state).toBe(0)
    expect(middle.project(sumProjection).state).toBe(11)
    expect(latest.project(sumProjection).state).toBe(3)
    expect(nested.project(sumProjection)).toMatchObject({
      state: 11,
      coverage: [
        { sessionId: parent.header.sessionId, through: 1 },
        { sessionId: middle.header.sessionId, through: 1 },
        { sessionId: nested.header.sessionId, through: 0 },
      ],
    })
    await repo.dispose()
  })

  it('rejects a second writer and permits a read snapshot beside the first', async () => {
    const repo = repository()
    const handle = await repo.create()
    await handle.append(deltaEvent, { value: 1 })
    await expect(repo.open(handle.header.sessionId)).rejects.toMatchObject({ code: 'SESSION_WRITE_LEASED' })
    await expect(repo.read(handle.header.sessionId)).resolves.toMatchObject({ localPosition: 1 })
    await repo.dispose()
  })

  it('publishes and releases the Repository through the Capability lifecycle', async () => {
    const registry = new CapabilityRegistry()
    const backend = new MemorySessionBackend({ maxRecordBytes: 4096 })
    registry.mount(createSessionRepositoryComponent({
      backend,
      catalog: createDurableEventCatalog([deltaEvent]),
      maxLineageDepth: 2,
      identitySource: identities(firstId),
    }))
    let resolved: SessionRepository | undefined
    registry.mount({
      label: 'Session consumer',
      requires: [SessionRepositoryKey],
      provides: [],
      setup: context => {
        resolved = context.require(SessionRepositoryKey)
      },
    })
    await registry.whenQuiescent()

    const active = resolved
    if (active === undefined) throw new Error('Session Repository was not resolved')
    await active.create()
    await registry.dispose()
    await expect(active.create()).rejects.toMatchObject({ code: 'SESSION_REPOSITORY_INACTIVE' })
  })

  it('applies maxLineageDepth as a parent-edge budget', async () => {
    const repo = new SessionRepository({
      backend: new MemorySessionBackend({ maxRecordBytes: 4096 }),
      catalog: createDurableEventCatalog(),
      maxLineageDepth: 0,
      identitySource: identities(firstId, secondId),
    })
    const root = await repo.create()
    await expect(repo.fork(root.header.sessionId)).rejects.toMatchObject({ code: 'SESSION_LINEAGE_LIMIT' })
    await repo.dispose()
  })

  it('rejects missing parents and lineage cycles as invalid lineage', async () => {
    const missingBackend = new MemorySessionBackend({ maxRecordBytes: 4096 })
    const a = parseSessionId('00000000-0000-4000-8000-000000000051')
    const b = parseSessionId('00000000-0000-4000-8000-000000000052')
    await missingBackend.create(Object.freeze({
      formatVersion: 1,
      sessionId: a,
      address: formatSessionAddress(a),
      createdAt: '2026-09-13T00:00:00.000Z',
      parent: Object.freeze({ sessionId: b, through: sessionLogPosition(0) }),
    }))
    const missingRepo = new SessionRepository({
      backend: missingBackend,
      catalog: createDurableEventCatalog(),
      maxLineageDepth: 3,
    })
    await expect(missingRepo.read(a)).rejects.toMatchObject({ code: 'SESSION_LINEAGE_INVALID' })
    await missingRepo.dispose()

    const cycleBackend = new MemorySessionBackend({ maxRecordBytes: 4096 })
    await cycleBackend.create(Object.freeze({
      formatVersion: 1,
      sessionId: a,
      address: formatSessionAddress(a),
      createdAt: '2026-09-13T00:00:00.000Z',
      parent: Object.freeze({ sessionId: b, through: sessionLogPosition(0) }),
    }))
    await cycleBackend.create(Object.freeze({
      formatVersion: 1,
      sessionId: b,
      address: formatSessionAddress(b),
      createdAt: '2026-09-13T00:00:00.000Z',
      parent: Object.freeze({ sessionId: a, through: sessionLogPosition(0) }),
    }))
    const cycleRepo = new SessionRepository({
      backend: cycleBackend,
      catalog: createDurableEventCatalog(),
      maxLineageDepth: 3,
    })
    await expect(cycleRepo.read(a)).rejects.toMatchObject({ code: 'SESSION_LINEAGE_INVALID' })
    await cycleRepo.dispose()
  })

  it('retains unknown ignorable events and reports them without calling the reducer', async () => {
    const backend = new MemorySessionBackend({ maxRecordBytes: 4096 })
    const rawId = parseSessionId('00000000-0000-4000-8000-000000000031')
    const header: SessionHeader = Object.freeze({
      formatVersion: 1,
      sessionId: rawId,
      address: formatSessionAddress(rawId),
      createdAt: '2026-09-13T00:00:00.000Z',
    })
    await backend.create(header)
    const writer = await backend.openWriter(rawId)
    const sequence = sessionSequence(1)
    const stored: StoredSessionEvent = Object.freeze({
      envelopeVersion: 1,
      sessionId: rawId,
      eventId: formatSessionEventId(rawId, sequence),
      sequence,
      recordedAt: '2026-09-13T00:00:01.000Z',
      type: 'future/optional',
      payloadVersion: 4,
      ignorable: true,
      payload: Object.freeze({ private: 'opaque' }),
    })
    await writer.append(sessionLogPosition(0), stored)
    await writer.dispose()
    const repo = new SessionRepository({
      backend,
      catalog: createDurableEventCatalog(),
      maxLineageDepth: 1,
    })
    const handle = await repo.open(rawId)
    let reducerCalls = 0
    const result = handle.project<number>({
      name: 'opaque counter',
      initial: () => 0,
      apply: state => {
        reducerCalls += 1
        return state + 1
      },
    })

    expect(handle.snapshot().history[0]?.events[0]?.kind).toBe('opaque')
    expect(result.state).toBe(0)
    expect(result.ignoredEvents).toEqual([{
      sessionId: rawId,
      eventId: stored.eventId,
      sequence: 1,
      type: 'future/optional',
      payloadVersion: 4,
    }])
    expect(reducerCalls).toBe(0)
    await repo.dispose()
  })

  it('rejects an unknown required event while opening', async () => {
    const backend = new MemorySessionBackend({ maxRecordBytes: 4096 })
    const rawId = parseSessionId('00000000-0000-4000-8000-000000000032')
    const header: SessionHeader = Object.freeze({
      formatVersion: 1,
      sessionId: rawId,
      address: formatSessionAddress(rawId),
      createdAt: '2026-09-13T00:00:00.000Z',
    })
    await backend.create(header)
    const writer = await backend.openWriter(rawId)
    const sequence = sessionSequence(1)
    await writer.append(sessionLogPosition(0), Object.freeze({
      envelopeVersion: 1,
      sessionId: rawId,
      eventId: formatSessionEventId(rawId, sequence),
      sequence,
      recordedAt: '2026-09-13T00:00:01.000Z',
      type: 'future/required',
      payloadVersion: 1,
      payload: Object.freeze({}),
    }))
    await writer.dispose()
    const repo = new SessionRepository({
      backend,
      catalog: createDurableEventCatalog(),
      maxLineageDepth: 1,
    })

    await expect(repo.open(rawId)).rejects.toMatchObject({ code: 'SESSION_EVENT_UNSUPPORTED' })
    await repo.dispose()
  })

  it('rejects any local record after the terminal event', async () => {
    const backend = new MemorySessionBackend({ maxRecordBytes: 4096 })
    const rawId = parseSessionId('00000000-0000-4000-8000-000000000033')
    await backend.create(Object.freeze({
      formatVersion: 1,
      sessionId: rawId,
      address: formatSessionAddress(rawId),
      createdAt: '2026-09-13T00:00:00.000Z',
    }))
    const writer = await backend.openWriter(rawId)
    const endedSequence = sessionSequence(1)
    await writer.append(sessionLogPosition(0), Object.freeze({
      envelopeVersion: 1,
      sessionId: rawId,
      eventId: formatSessionEventId(rawId, endedSequence),
      sequence: endedSequence,
      recordedAt: '2026-09-13T00:00:01.000Z',
      type: sessionEndedEvent.type,
      payloadVersion: sessionEndedEvent.payloadVersion,
      payload: Object.freeze({}),
    }))
    const nextSequence = sessionSequence(2)
    await writer.append(sessionLogPosition(1), Object.freeze({
      envelopeVersion: 1,
      sessionId: rawId,
      eventId: formatSessionEventId(rawId, nextSequence),
      sequence: nextSequence,
      recordedAt: '2026-09-13T00:00:02.000Z',
      type: deltaEvent.type,
      payloadVersion: deltaEvent.payloadVersion,
      payload: Object.freeze({ value: 1 }),
    }))
    await writer.dispose()
    const repo = new SessionRepository({
      backend,
      catalog: createDurableEventCatalog([deltaEvent]),
      maxLineageDepth: 1,
    })

    await expect(repo.open(rawId)).rejects.toMatchObject({ code: 'SESSION_LOG_INVALID' })
    await repo.dispose()
  })

  it('does not advance the Handle after a size failure', async () => {
    const textEvent = createDurableEventDefinition<JsonObject>({
      type: 'test/large',
      payloadVersion: 1,
      ignorable: false,
      decode: value => value as JsonObject,
    })
    const repo = new SessionRepository({
      backend: new MemorySessionBackend({ maxRecordBytes: 400 }),
      catalog: createDurableEventCatalog([deltaEvent, textEvent]),
      maxLineageDepth: 1,
      identitySource: identities(firstId),
    })
    const handle = await repo.create()

    await expect(handle.append(textEvent, { text: 'x'.repeat(5_000) })).rejects.toMatchObject({
      code: 'SESSION_RECORD_TOO_LARGE',
    })
    expect(handle.status).toBe('open')
    expect(handle.snapshot().localPosition).toBe(0)
    await expect(handle.append(deltaEvent, { value: 1 })).resolves.toMatchObject({
      stored: { sequence: 1 },
    })
    await repo.dispose()
  })

  it('faults a Handle whose Backend reports an ambiguous append and keeps its old snapshot', async () => {
    class AmbiguousBackend implements SessionBackend {
      readonly inner = new MemorySessionBackend({ maxRecordBytes: 4096 })
      writerLive = false
      unknown = false

      create(header: SessionHeader): Promise<void> {
        return this.inner.create(header)
      }

      async openWriter(sessionId: SessionId): Promise<SessionWriter> {
        const writer = await this.inner.openWriter(sessionId)
        this.writerLive = true
        return {
          header: writer.header,
          readCommitted: () => writer.readCommitted(),
          append: async (position, event) => {
            await writer.append(position, event)
            this.unknown = true
            throw new SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'injected ambiguous commit')
          },
          dispose: async () => {
            await writer.dispose()
            this.writerLive = false
          },
        }
      }

      readPrefix(sessionId: SessionId, through?: ReturnType<typeof sessionLogPosition>) {
        if (this.unknown && this.writerLive) {
          return Promise.reject(new SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'commit boundary unknown'))
        }
        return this.inner.readPrefix(sessionId, through)
      }

      dispose(): Promise<void> {
        return this.inner.dispose()
      }
    }

    const backend = new AmbiguousBackend()
    const repo = new SessionRepository({
      backend,
      catalog: createDurableEventCatalog([deltaEvent]),
      maxLineageDepth: 1,
      identitySource: identities(firstId),
    })
    const handle = await repo.create()
    await expect(handle.append(deltaEvent, { value: 5 })).rejects.toMatchObject({
      code: 'SESSION_APPEND_OUTCOME_UNKNOWN',
    })
    expect(handle.status).toBe('faulted')
    expect(handle.snapshot().localPosition).toBe(0)
    await expect(repo.read(handle.header.sessionId)).rejects.toMatchObject({
      code: 'SESSION_APPEND_OUTCOME_UNKNOWN',
    })
    await handle.dispose()
    await expect(repo.read(handle.header.sessionId)).resolves.toMatchObject({ localPosition: 1 })
    await repo.dispose()
  })
})

import { describe, expect, it } from 'vitest'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'
import {
  CapabilityRegistry,
  createDurableEventCatalog,
  createDurableEventDefinition,
  createSessionRepositoryComponent,
  MemorySessionBackend,
  SessionRepository,
  SessionRepositoryKey,
} from '../../src/index.js'
import type { SessionBackend } from '../../src/index.js'
import {
  createTestRepository,
  deltaDecoder,
  deltaEvent,
  firstId,
  identities,
} from './fixtures.js'
import type { Delta } from './fixtures.js'

describe('Session Repository and Handle', () => {
  it('serializes accepted appends, snapshots payloads, and ends independently of disposal', async () => {
    const repo = createTestRepository()
    const handle = await repo.create()
    const mutable = { value: 2 }
    const first = handle.append(deltaEvent, mutable)
    mutable.value = 100
    const second = handle.append(deltaEvent, { value: 3 })

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { stored: { sequence: 1 }, payload: { value: 2 } },
      { stored: { sequence: 2 }, payload: { value: 3 } },
    ])
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

  it('orders end after accepted appends and keeps Handle release distinct from Session ending', async () => {
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
    const disposal = handle.dispose()
    expect(handle.dispose()).toBe(disposal)
    expect(() => handle.append(deltaEvent, { value: 3 })).toThrowError(
      expect.objectContaining({
        code: 'SESSION_HANDLE_INACTIVE',
        details: { sessionId: handle.header.sessionId, status: 'releasing' },
      }),
    )
    releaseAppend.resolve(undefined)
    await expect(Promise.all([append, ending, disposal])).resolves.toMatchObject([
      { stored: { sequence: 1 } },
      { stored: { sequence: 2, type: 'session/ended' } },
      undefined,
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
    const disposal = repo.dispose()
    expect(repo.dispose()).toBe(disposal)
    void disposal.then(() => {
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
    const repo = createTestRepository()
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

  it('rejects a second writer and permits a read snapshot beside the first', async () => {
    const repo = createTestRepository()
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
})

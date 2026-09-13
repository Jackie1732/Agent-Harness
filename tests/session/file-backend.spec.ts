import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDurableEventCatalog,
  createDurableEventDefinition,
  FileSessionBackend,
  parseSessionId,
  SessionRepository,
} from '../../src/index.js'
import { createFileSessionBackendForTest } from '../../src/session/file-backend.js'
import { writeAll } from '../../src/session/file-store.js'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'
import type {
  CommittedSessionEvent,
  JsonObject,
  JsonValue,
  SessionIdentitySource,
  SessionProjection,
} from '../../src/index.js'

interface NotePayload extends JsonObject {
  readonly text: string
}

const noteEvent = createDurableEventDefinition<NotePayload>({
  type: 'test/note',
  payloadVersion: 1,
  ignorable: false,
  decode: (value: JsonValue) => {
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new TypeError('note.text must be a string')
    }
    const object = value as JsonObject
    if (typeof object.text !== 'string') throw new TypeError('note.text must be a string')
    return { text: object.text }
  },
})

const sessionIdText = '00000000-0000-4000-8000-000000000021'
const sessionId = parseSessionId(sessionIdText)

function oneIdentity(): SessionIdentitySource {
  let used = false
  return {
    nextSessionId: () => {
      if (used) throw new Error('identity fixture exhausted')
      used = true
      return sessionId
    },
  }
}

const projection: SessionProjection<readonly string[]> = Object.freeze({
  name: 'notes',
  initial: () => [],
  apply: (state: readonly string[], event: CommittedSessionEvent) => event.stored.type === noteEvent.type
    ? [...state, (event.payload as NotePayload).text]
    : state,
})

const roots: string[] = []

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'atomic-harness-session-'))
  roots.push(path)
  return path
}

function repository(path: string): SessionRepository {
  return new SessionRepository({
    backend: new FileSessionBackend({ root: path, maxRecordBytes: 4096 }),
    catalog: createDurableEventCatalog([noteEvent]),
    maxLineageDepth: 3,
    identitySource: oneIdentity(),
    clock: { now: () => 1_789_257_600_000 },
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('File Session Backend', () => {
  it('advances explicit offsets until a partial-write adapter consumes the full frame', async () => {
    const positions: number[] = []
    const handle = {
      write: async (_bytes: Uint8Array, _offset: number, length: number, position: number) => {
        positions.push(position)
        return { bytesWritten: Math.min(2, length), buffer: Buffer.alloc(0) }
      },
    } as unknown as FileHandle

    await writeAll(handle, Buffer.from('abcde'), 10)
    expect(positions).toEqual([10, 12, 14])
  })

  it('reopens a committed log through a fresh Backend instance', async () => {
    const path = await root()
    const first = repository(path)
    const handle = await first.create()
    await handle.append(noteEvent, { text: 'persisted' })
    await handle.dispose()
    await first.dispose()

    const second = repository(path)
    const reopened = await second.open(sessionId)
    expect(reopened.snapshot()).toMatchObject({ localPosition: 1, lifecycle: 'active' })
    expect(reopened.project(projection).state).toEqual(['persisted'])
    await second.dispose()
  })

  it('reports an interrupted physical tail to readers and truncates it for a writer', async () => {
    const path = await root()
    const first = repository(path)
    const handle = await first.create()
    await handle.append(noteEvent, { text: 'kept' })
    await first.dispose()
    const log = join(path, 'sessions', sessionIdText, 'events.log')
    const committedSize = (await stat(log)).size
    await appendFile(log, Buffer.from('123\t'))

    const readerBackend = new FileSessionBackend({ root: path, maxRecordBytes: 4096 })
    const read = await readerBackend.readPrefix(sessionId)
    expect(read.events).toHaveLength(1)
    expect(read.incompleteTail).toEqual({ byteOffset: committedSize, byteLength: 4 })
    expect((await stat(log)).size).toBe(committedSize + 4)
    await readerBackend.dispose()

    const writerBackend = new FileSessionBackend({ root: path, maxRecordBytes: 4096 })
    const writer = await writerBackend.openWriter(sessionId)
    expect((await stat(log)).size).toBe(committedSize)
    expect((await writer.readCommitted()).events).toHaveLength(1)
    await writer.dispose()
    await writerBackend.dispose()
  })

  it('fails closed on an invalid tail and leaves the bytes unchanged', async () => {
    const path = await root()
    const first = repository(path)
    await first.create()
    await first.dispose()
    const log = join(path, 'sessions', sessionIdText, 'events.log')
    await appendFile(log, Buffer.from('x'))
    const before = await readFile(log)

    const backend = new FileSessionBackend({ root: path, maxRecordBytes: 4096 })
    await expect(backend.readPrefix(sessionId)).rejects.toMatchObject({ code: 'SESSION_LOG_INVALID' })
    await expect(backend.openWriter(sessionId)).rejects.toMatchObject({ code: 'SESSION_LOG_INVALID' })
    expect(await readFile(log)).toEqual(before)
    await backend.dispose()
  })

  it('keeps a child readable when corruption is only after its captured parent cut', async () => {
    const path = await root()
    const childId = parseSessionId('00000000-0000-4000-8000-000000000022')
    const values = [sessionId, childId]
    let identityIndex = 0
    const first = new SessionRepository({
      backend: new FileSessionBackend({ root: path, maxRecordBytes: 4096 }),
      catalog: createDurableEventCatalog([noteEvent]),
      maxLineageDepth: 2,
      identitySource: {
        nextSessionId: () => {
          const value = values[identityIndex]
          if (value === undefined) throw new Error('identity fixture exhausted')
          identityIndex += 1
          return value
        },
      },
    })
    const parent = await first.create()
    await parent.append(noteEvent, { text: 'captured' })
    const child = await first.fork(parent.header.sessionId)
    await first.dispose()
    const parentLog = join(path, 'sessions', sessionIdText, 'events.log')
    await appendFile(parentLog, Buffer.from('x'))

    const second = new SessionRepository({
      backend: new FileSessionBackend({ root: path, maxRecordBytes: 4096 }),
      catalog: createDurableEventCatalog([noteEvent]),
      maxLineageDepth: 2,
    })
    await expect(second.read(child.header.sessionId)).resolves.toMatchObject({
      history: [
        { header: { sessionId }, through: 1 },
        { header: { sessionId: childId }, through: 0 },
      ],
    })
    await expect(second.read(parent.header.sessionId)).rejects.toMatchObject({
      code: 'SESSION_LOG_INVALID',
    })
    await second.dispose()
  })

  it('shares the process-local writer lease across Backend instances', async () => {
    const path = await root()
    const first = repository(path)
    const handle = await first.create()
    const other = new FileSessionBackend({ root: path, maxRecordBytes: 4096 })

    await expect(other.openWriter(handle.header.sessionId)).rejects.toMatchObject({
      code: 'SESSION_WRITE_LEASED',
    })
    await first.dispose()
    const writer = await other.openWriter(sessionId)
    await writer.dispose()
    await other.dispose()
  })

  it('holds readers outside the commit boundary until sync succeeds', async () => {
    const path = await root()
    const syncStarted = createDeferred<void>()
    const releaseSync = createDeferred<void>()
    const options = { root: path, maxRecordBytes: 4096 }
    const backend = createFileSessionBackendForTest(options, {
      writeAll,
      sync: async handle => {
        syncStarted.resolve(undefined)
        await releaseSync.promise
        await handle.sync()
      },
    })
    const repo = new SessionRepository({
      backend,
      catalog: createDurableEventCatalog([noteEvent]),
      maxLineageDepth: 2,
      identitySource: oneIdentity(),
    })
    const handle = await repo.create()
    const append = handle.append(noteEvent, { text: 'held' })
    await syncStarted.promise
    let readSettled = false
    const read = repo.read(sessionId).finally(() => {
      readSettled = true
    })
    await drainMicrotasks()
    expect(readSettled).toBe(false)

    releaseSync.resolve(undefined)
    await append
    await expect(read).resolves.toMatchObject({ localPosition: 1 })
    await repo.dispose()
  })

  it('hides an unconfirmed full frame until release and resolves it by reopening', async () => {
    const path = await root()
    const options = { root: path, maxRecordBytes: 4096 }
    const backend = createFileSessionBackendForTest(options, {
      writeAll,
      sync: async () => {
        throw new Error('injected sync failure')
      },
    })
    const first = new SessionRepository({
      backend,
      catalog: createDurableEventCatalog([noteEvent]),
      maxLineageDepth: 2,
      identitySource: oneIdentity(),
    })
    const handle = await first.create()

    await expect(handle.append(noteEvent, { text: 'uncertain' })).rejects.toMatchObject({
      code: 'SESSION_APPEND_OUTCOME_UNKNOWN',
    })
    expect(handle.status).toBe('faulted')
    await expect(first.read(sessionId)).rejects.toMatchObject({
      code: 'SESSION_APPEND_OUTCOME_UNKNOWN',
    })
    await first.dispose()

    const second = repository(path)
    const reopened = await second.open(sessionId)
    expect(reopened.snapshot().localPosition).toBe(1)
    expect(reopened.project(projection).state).toEqual(['uncertain'])
    await second.dispose()
  })
})

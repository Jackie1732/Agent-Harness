import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileSessionBackend,
  SessionRepository,
  createDurableEventCatalog,
  formatSessionAddress,
  formatSessionEventId,
  parseSessionId,
  sessionLogPosition,
  sessionSequence,
} from '../../src/index.js'
import type { JsonValue, SessionHeader, StoredSessionEvent } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'
import { deltaEvent, firstId, secondId } from './fixtures.js'

const id = parseSessionId(firstId)
const parentId = parseSessionId(secondId)
const tail = Buffer.from('123\t')

function header(sessionId = id, parent?: SessionHeader['parent']): SessionHeader {
  return { formatVersion: 1, sessionId, address: formatSessionAddress(sessionId),
    createdAt: '2026-10-10T00:00:00.000Z', ...(parent === undefined ? {} : { parent }) }
}

function event(sequenceValue: number, type = deltaEvent.type, payload: JsonValue = { value: sequenceValue }): StoredSessionEvent {
  const sequence = sessionSequence(sequenceValue)
  return { envelopeVersion: 1, sessionId: id, eventId: formatSessionEventId(id, sequence), sequence,
    recordedAt: '2026-10-10T00:00:01.000Z', type, payloadVersion: 1, payload }
}

interface FileFixture {
  readonly root: string
  readonly backend: FileSessionBackend
  readonly repository: SessionRepository
  readonly log: string
  readonly before: Buffer
}

async function withInterruptedLog(
  input: { readonly header?: SessionHeader; readonly events?: readonly StoredSessionEvent[]; readonly otherHeaders?: readonly SessionHeader[] },
  run: (fixture: FileFixture) => Promise<void>,
): Promise<void> {
  const temporaryParent = tmpdir()
  const root = await mkdtemp(join(temporaryParent, 'atomic-semantic-recovery-'))
  const backend = new FileSessionBackend({ root, maxRecordBytes: 4096 })
  const repository = new SessionRepository({ backend, catalog: createDurableEventCatalog([deltaEvent]), maxLineageDepth: 3 })
  try {
    await backend.create(input.header ?? header())
    for (const other of input.otherHeaders ?? []) await backend.create(other)
    const writer = await backend.openWriter(id)
    for (const stored of input.events ?? [event(1)]) await writer.append(sessionLogPosition(stored.sequence - 1), stored)
    await writer.dispose()
    const log = join(root, 'sessions', firstId, 'events.log')
    await appendFile(log, tail)
    await run({ root, backend, repository, log, before: await readFile(log) })
  } finally {
    try { await repository.dispose() }
    finally {
      expect(dirname(root)).toBe(temporaryParent)
      await rm(root, { recursive: true, force: true })
    }
  }
}

describe('File recovery validates committed semantics before truncation', () => {
  it.each([
    { label: 'unsupported required event', input: { events: [event(1, 'test/unsupported')] }, code: 'SESSION_EVENT_UNSUPPORTED' },
    { label: 'invalid known payload', input: { events: [event(1, deltaEvent.type, { value: 'invalid' })] }, code: 'SESSION_EVENT_INVALID' },
    { label: 'record after local end', input: { events: [event(1, 'session/ended', {}), event(2)] }, code: 'SESSION_LOG_INVALID' },
    { label: 'missing parent', input: { header: header(id, { sessionId: parentId, through: sessionLogPosition(0) }) }, code: 'SESSION_LINEAGE_INVALID' },
    { label: 'cyclic lineage', input: { header: header(id, { sessionId: parentId, through: sessionLogPosition(0) }),
      otherHeaders: [header(parentId, { sessionId: id, through: sessionLogPosition(0) })] }, code: 'SESSION_LINEAGE_INVALID' },
  ])('preserves an interrupted tail with $label', async ({ input, code }) => {
    await withInterruptedLog(input, async ({ repository, log, before }) => {
      await expect(repository.read(id)).rejects.toMatchObject({ code })
      expect(await readFile(log)).toEqual(before)
      await expect(repository.open(id)).rejects.toMatchObject({ code })
      expect(await readFile(log)).toEqual(before)
      await expect(repository.open(id)).rejects.toMatchObject({ code })
      expect(await readFile(log)).toEqual(before)
    })
  })

  it('holds the lease while validation can read the same Session outside its gate', async () => {
    await withInterruptedLog({}, async ({ backend, root, log, before }) => {
      const entered = createDeferred<void>(), release = createDeferred<void>()
      const other = new FileSessionBackend({ root, maxRecordBytes: 4096 })
      const pending = backend.openWriter(id, async local => {
        expect(local.incompleteTail?.byteLength).toBe(tail.byteLength)
        expect(Object.isFrozen(local)).toBe(true)
        expect(Object.isFrozen(local.events)).toBe(true)
        expect((await backend.readPrefix(id)).position).toBe(local.position)
        entered.resolve()
        await release.promise
      })
      try {
        await entered.promise
        expect(await readFile(log)).toEqual(before)
        expect((await other.readPrefix(id)).position).toBe(1)
        await expect(other.openWriter(id)).rejects.toMatchObject({ code: 'SESSION_WRITE_LEASED' })
        release.resolve()
        const writer = await pending
        expect(await readFile(log)).toEqual(before.subarray(0, -tail.byteLength))
        expect((await writer.readCommitted()).position).toBe(1)
        await writer.dispose()
      } finally {
        release.resolve()
        await pending.then(writer => writer.dispose(), () => undefined)
        await other.dispose()
      }
    })
  })

  it('releases a failed validation without truncating and permits a later valid Writer', async () => {
    await withInterruptedLog({}, async ({ backend, log, before }) => {
      const failure = new Error('validation failed')
      await expect(backend.openWriter(id, () => { throw failure })).rejects.toBe(failure)
      expect(await readFile(log)).toEqual(before)
      const writer = await backend.openWriter(id, local => { expect(local.position).toBe(1) })
      expect(await readFile(log)).toEqual(before.subarray(0, -tail.byteLength))
      expect(writer.dispose()).toBe(writer.dispose())
      await writer.dispose()
    })
  })

  it('returns a captured Writer prefix and rejects a read queued behind release', async () => {
    await withInterruptedLog({}, async ({ backend }) => {
      const first = await backend.openWriter(id)
      const read = first.readCommitted()
      const released = first.dispose()
      await expect(read).resolves.toMatchObject({ position: 1 })
      await released

      const second = await backend.openWriter(id)
      const disposed = second.dispose()
      const rejected = expect(second.readCommitted()).rejects.toMatchObject({ code: 'SESSION_HANDLE_INACTIVE' })
      await disposed
      await rejected
    })
  })

  it('retires a candidate on Backend disposal without disturbing its successor lease', async () => {
    await withInterruptedLog({}, async ({ backend, root, log, before }) => {
      const entered = createDeferred<void>(), release = createDeferred<void>()
      const other = new FileSessionBackend({ root, maxRecordBytes: 4096 })
      const pending = backend.openWriter(id, async () => { entered.resolve(); await release.promise })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'SESSION_REPOSITORY_INACTIVE' })
      try {
        await entered.promise
        await backend.dispose()
        expect(await readFile(log)).toEqual(before)
        const successor = await other.openWriter(id)
        await successor.append(sessionLogPosition(1), event(2))
        release.resolve()
        await rejected
        expect((await successor.readCommitted()).position).toBe(2)
        await expect(other.openWriter(id)).rejects.toMatchObject({ code: 'SESSION_WRITE_LEASED' })
        await successor.dispose()
      } finally {
        release.resolve()
        await pending.catch(() => undefined)
        await other.dispose()
      }
    })
  })
})

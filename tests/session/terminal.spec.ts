import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDurableEventCatalog,
  FileSessionBackend,
  MemorySessionBackend,
  sessionEndedEvent,
  sessionLogPosition,
  SessionRepository,
} from '../../src/index.js'
import { createTestRepository, deltaEvent, firstId, identities, secondId } from './fixtures.js'

describe('Session terminal event admission', () => {
  it.each(['append', 'appendIfPosition', 'end'] as const)('%s shares terminal work and preserves already accepted appends', async operation => {
    const repository = createTestRepository()
    try {
      const handle = await repository.create()
      const preceding = handle.append(deltaEvent, { value: 1 })
      const terminal = operation === 'append' ? handle.append(sessionEndedEvent, { reason: 'complete' })
        : operation === 'appendIfPosition' ? handle.appendIfPosition(sessionLogPosition(1), sessionEndedEvent, { reason: 'complete' })
          : handle.end('complete')

      expect(handle.end('another reason')).toBe(terminal)
      expect(() => handle.append(deltaEvent, { value: 2 })).toThrowError(expect.objectContaining({ code: 'SESSION_ENDED' }))
      const committed = await terminal
      expect((await preceding).stored.sequence).toBe(1)
      expect(committed).toMatchObject({ stored: { sequence: 2 }, payload: { reason: 'complete' } })
      expect(await handle.end()).toBe(committed)
      expect(handle.snapshot()).toMatchObject({ localPosition: 2, lifecycle: 'ended' })
    } finally { await repository.dispose() }
  })

  it('reopens admission after a queued terminal precondition fails without writing', async () => {
    const repository = createTestRepository()
    try {
      const handle = await repository.create()
      const preceding = handle.append(deltaEvent, { value: 1 })
      const terminal = handle.appendIfPosition(sessionLogPosition(0), sessionEndedEvent, {})
      expect(handle.end()).toBe(terminal)
      await preceding
      await expect(terminal).rejects.toMatchObject({ code: 'SESSION_PRECONDITION_FAILED' })
      expect(handle.status).toBe('open')
      expect(handle.snapshot()).toMatchObject({ localPosition: 1, lifecycle: 'active' })
      await handle.append(deltaEvent, { value: 2 })
      expect((await handle.end()).stored.sequence).toBe(3)
    } finally { await repository.dispose() }
  })

  it('leaves admission open when a terminal payload fails before queueing', async () => {
    const repository = createTestRepository()
    try {
      const handle = await repository.create()
      expect(() => handle.append(sessionEndedEvent, { reason: 3 })).toThrowError(expect.objectContaining({ code: 'SESSION_EVENT_INVALID' }))
      await handle.append(deltaEvent, { value: 1 })
      expect((await handle.end()).stored.sequence).toBe(2)
    } finally { await repository.dispose() }
  })

  it('reopens admission after a definitely unwritten terminal size failure', async () => {
    const repository = createTestRepository()
    try {
      const handle = await repository.create()
      const terminal = handle.append(sessionEndedEvent, { reason: 'x'.repeat(5_000) })
      expect(handle.end()).toBe(terminal)
      await expect(terminal).rejects.toMatchObject({ code: 'SESSION_RECORD_TOO_LARGE' })
      expect(handle.snapshot()).toMatchObject({ localPosition: 0, lifecycle: 'active' })
      expect(handle.status).toBe('open')
      await handle.append(deltaEvent, { value: 1 })
      expect((await handle.end()).stored.sequence).toBe(2)
    } finally { await repository.dispose() }
  })

  it.each(['memory', 'file'] as const)('%s keeps direct terminal records stable across reopen and fork', async kind => {
    const root = kind === 'file' ? await mkdtemp(join(tmpdir(), 'atomic-harness-terminal-')) : undefined
    const backend = root === undefined ? new MemorySessionBackend({ maxRecordBytes: 4096 })
      : new FileSessionBackend({ root, maxRecordBytes: 4096 })
    const repository = new SessionRepository({ backend, catalog: createDurableEventCatalog([deltaEvent]),
      maxLineageDepth: 2, identitySource: identities(firstId, secondId) })
    let reopenedRepository: SessionRepository | undefined
    try {
      const handle = await repository.create()
      const terminal = await handle.append(sessionEndedEvent, { reason: 'complete' })
      const endedSnapshot = handle.snapshot()
      await handle.dispose()
      const reopened = await repository.open(handle.header.sessionId)
      expect(reopened.snapshot()).toEqual(endedSnapshot)
      expect(await reopened.end('ignored')).toEqual(terminal)
      expect(() => reopened.append(deltaEvent, { value: 1 })).toThrowError(expect.objectContaining({ code: 'SESSION_ENDED' }))
      const child = await repository.fork(handle.header.sessionId)
      await child.append(deltaEvent, { value: 2 })
      expect(child.snapshot()).toMatchObject({ lifecycle: 'active', localPosition: 1,
        history: [{ localLifecycle: 'ended', through: 1 }, { localLifecycle: 'active', through: 1 }] })

      if (root !== undefined) {
        await repository.dispose()
        reopenedRepository = new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: 4096 }),
          catalog: createDurableEventCatalog([deltaEvent]), maxLineageDepth: 2 })
        expect((await reopenedRepository.open(handle.header.sessionId)).snapshot()).toEqual(endedSnapshot)
      }
    } finally {
      await reopenedRepository?.dispose()
      await repository.dispose()
      if (root !== undefined) await rm(root, { recursive: true, force: true })
    }
  })
})

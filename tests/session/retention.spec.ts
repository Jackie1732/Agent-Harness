import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import { createDurableEventCatalog, MemorySessionBackend, SessionRepository } from '../../src/index.js'
import { deltaEvent, firstId, identities } from './fixtures.js'

async function releasedFixture(keepSnapshot: boolean) {
  const backend = new MemorySessionBackend({ maxRecordBytes: 4096 })
  const clock = { now: () => 1_789_257_600_000 }
  const repository = new SessionRepository({ backend, clock, catalog: createDurableEventCatalog([deltaEvent]),
    maxLineageDepth: 1, identitySource: identities(firstId) })
  const handle = await repository.create()
  await handle.append(deltaEvent, { value: 1 })
  await handle.end('finished')
  const snapshot = handle.snapshot()
  const refs = { backend: new WeakRef(backend), repository: new WeakRef(repository), clock: new WeakRef(clock), history: new WeakRef(snapshot.history) }
  await handle.dispose()
  await repository.dispose()
  return { handle, refs, snapshot: keepSnapshot ? snapshot : undefined }
}

async function collect(): Promise<void> {
  await setImmediate()
  queryObjects(SessionRepository, { format: 'count' })
}

it('retires the released Handle runtime while preserving its public metadata and Catalog queries', async () => {
  const { handle, refs } = await releasedFixture(false)
  await collect()
  expect(handle.status).toBe('disposed')
  expect(handle.header.sessionId).toBe(firstId)
  expect(Object.isFrozen(handle.header)).toBe(true)
  expect(handle.maxRecordBytes).toBe(4096)
  expect(handle.supportsEventDefinition(deltaEvent)).toBe(true)
  expect(() => handle.snapshot()).toThrowError(expect.objectContaining({ code: 'SESSION_HANDLE_INACTIVE' }))
  expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined]))).toEqual({
    backend: false, repository: false, clock: false, history: false,
  })
  expect(handle.dispose()).toBe(handle.dispose())
})

it('keeps an explicitly retained immutable Snapshot independently of released resources', async () => {
  const { handle, refs, snapshot } = await releasedFixture(true)
  await collect()
  expect(snapshot).toMatchObject({ lifecycle: 'ended', localPosition: 2 })
  expect(refs.history.deref()).toBe(snapshot?.history)
  expect(refs.repository.deref()).toBeUndefined()
  expect(refs.backend.deref()).toBeUndefined()
  expect(refs.clock.deref()).toBeUndefined()
  expect(handle.header).toBe(snapshot?.header)
  expect(Object.isFrozen(snapshot?.history)).toBe(true)
})

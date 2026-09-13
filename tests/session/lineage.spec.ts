import { describe, expect, it } from 'vitest'
import {
  createDurableEventCatalog,
  formatSessionAddress,
  MemorySessionBackend,
  parseSessionId,
  sessionLogPosition,
  SessionRepository,
} from '../../src/index.js'
import {
  createTestRepository,
  deltaEvent,
  firstId,
  identities,
  secondId,
  sumProjection,
} from './fixtures.js'

describe('Session lineage', () => {
  it('keeps a child on its captured parent prefix and does not inherit parent termination', async () => {
    const repo = createTestRepository()
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
    const repo = createTestRepository(identities(
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

})

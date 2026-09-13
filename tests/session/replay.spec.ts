import { describe, expect, it } from 'vitest'
import {
  createDurableEventCatalog,
  formatSessionAddress,
  formatSessionEventId,
  MemorySessionBackend,
  parseSessionId,
  sessionLogPosition,
  sessionSequence,
  SessionRepository,
  sessionEndedEvent,
} from '../../src/index.js'
import type {
  JsonObject,
  SessionHeader,
  SessionProjection,
  StoredSessionEvent,
} from '../../src/index.js'
import { createTestRepository, deltaEvent } from './fixtures.js'
import type { Delta } from './fixtures.js'

describe('Session replay and Projection', () => {
  it('contains Projection mutation failures without changing the log or Writer', async () => {
    const repo = createTestRepository()
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
    const repo = createTestRepository()
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

    const first = handle.project(projection())
    expect(first).toEqual(handle.project(projection()))
    expect(first.state).toBe(5)
    await repo.dispose()
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

})

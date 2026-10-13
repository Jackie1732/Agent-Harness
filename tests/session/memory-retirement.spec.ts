import { expect, it } from 'vitest'
import {
  formatSessionAddress,
  formatSessionEventId,
  MemorySessionBackend,
  parseSessionId,
  sessionLogPosition,
  sessionSequence,
} from '../../src/index.js'
import type { LocalStoredSession, StoredSessionEvent } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'

const id = parseSessionId('00000000-0000-4000-8000-000000000181')
const header = { formatVersion: 1 as const, sessionId: id, address: formatSessionAddress(id), createdAt: '2026-10-13T00:00:00.000Z' }

function event(value: number): StoredSessionEvent {
  const sequence = sessionSequence(value)
  return { envelopeVersion: 1, sessionId: id, eventId: formatSessionEventId(id, sequence), sequence,
    recordedAt: '2026-10-13T00:00:01.000Z', type: 'test/recorded', payloadVersion: 1, payload: { nested: { value } } }
}

it('keeps explicitly retained prefixes unchanged when the Memory Backend closes with an open Writer', async () => {
  const backend = new MemorySessionBackend({ maxRecordBytes: 4096 })
  await backend.create(header)
  const writer = await backend.openWriter(id)
  try {
    await writer.append(sessionLogPosition(0), event(1))
    const earlier = await writer.readCommitted()
    await writer.append(sessionLogPosition(1), event(2))
    const complete = await backend.readPrefix(id)
    await backend.dispose()

    expect(earlier).toMatchObject({ position: 1, events: [{ payload: { nested: { value: 1 } } }] })
    expect(earlier.events).toHaveLength(1)
    expect(complete).toMatchObject({ position: 2, events: [{ payload: { nested: { value: 1 } } }, { payload: { nested: { value: 2 } } }] })
    expect(complete.events).toHaveLength(2)
    expect(Object.isFrozen(earlier.events)).toBe(true)
    expect(Object.isFrozen(complete.events[0]!.payload)).toBe(true)
    expect(writer.header).toEqual(header)
    await expect(writer.readCommitted()).rejects.toMatchObject({ code: 'SESSION_REPOSITORY_INACTIVE' })
    await expect(backend.readPrefix(id)).rejects.toMatchObject({ code: 'SESSION_REPOSITORY_INACTIVE' })
  } finally {
    await writer.dispose()
    await backend.dispose()
  }
})

it('preserves the fixed validation prefix while Backend closure rejects publication of its queued Writer', async () => {
  const backend = new MemorySessionBackend({ maxRecordBytes: 4096 })
  await backend.create(header)
  const writer = await backend.openWriter(id)
  await writer.append(sessionLogPosition(0), event(1))
  await writer.dispose()
  const entered = createDeferred<LocalStoredSession>()
  const release = createDeferred<void>()
  const candidate = backend.openWriter(id, async local => { entered.resolve(local); await release.promise })
  const settlement = Promise.allSettled([candidate])
  try {
    const fixed = await entered.promise
    const reader = await backend.readPrefix(id)
    await backend.dispose()

    expect(fixed).toMatchObject({ position: 1, events: [{ payload: { nested: { value: 1 } } }] })
    expect(fixed.events).toHaveLength(1)
    expect(reader).toEqual(fixed)
    expect(Object.isFrozen(fixed.events)).toBe(true)
    release.resolve()
    expect(await settlement).toEqual([{ status: 'rejected', reason: expect.objectContaining({ code: 'SESSION_REPOSITORY_INACTIVE' }) }])
    await expect(backend.openWriter(id)).rejects.toMatchObject({ code: 'SESSION_REPOSITORY_INACTIVE' })
  } finally {
    release.resolve()
    await candidate.then(opened => opened.dispose(), () => undefined)
    await backend.dispose()
  }
})

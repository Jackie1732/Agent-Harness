import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileSessionBackend,
  MemorySessionBackend,
  formatSessionAddress,
  formatSessionEventId,
  parseSessionId,
  sessionLogPosition,
  sessionSequence,
} from '../../src/index.js'
import type { SessionBackend, SessionHeader, StoredSessionEvent } from '../../src/index.js'

const id = parseSessionId('00000000-0000-4000-8000-000000000133')
const header: SessionHeader = {
  formatVersion: 1,
  sessionId: id,
  address: formatSessionAddress(id),
  createdAt: '2026-10-10T00:00:00.000Z',
}

function event(payload: StoredSessionEvent['payload']): StoredSessionEvent {
  const sequence = sessionSequence(1)
  return {
    envelopeVersion: 1,
    sessionId: id,
    eventId: formatSessionEventId(id, sequence),
    sequence,
    recordedAt: '2026-10-10T00:00:01.000Z',
    type: 'admission/recorded',
    payloadVersion: 1,
    payload,
  }
}

async function usingBackend(kind: 'Memory' | 'File', run: (backend: SessionBackend) => Promise<void>): Promise<void> {
  const temporaryParent = tmpdir()
  const root = kind === 'File' ? await mkdtemp(join(temporaryParent, 'atomic-harness-admission-')) : undefined
  const backend: SessionBackend = root === undefined
    ? new MemorySessionBackend({ maxRecordBytes: 2048 })
    : new FileSessionBackend({ root, maxRecordBytes: 2048 })
  try {
    await backend.create(header)
    await run(backend)
  } finally {
    try {
      await backend.dispose()
    } finally {
      if (root !== undefined) {
        expect(dirname(root)).toBe(temporaryParent)
        await rm(root, { recursive: true, force: true })
      }
    }
  }
}

describe.each(['Memory', 'File'] as const)('%s Writer admission', kind => {
  it('captures nested payloads before queued work begins', async () => {
    await usingBackend(kind, async backend => {
      const writer = await backend.openWriter(id)
      const payload = { values: [1], nested: { value: 2 } }
      const committed = writer.append(sessionLogPosition(0), event(payload))
      payload.values.push(9)
      payload.nested.value = 8

      await expect(committed).resolves.toBe(1)
      const snapshot = await writer.readCommitted()
      expect(snapshot.events[0]?.payload).toEqual({ values: [1], nested: { value: 2 } })
      expect(Object.isFrozen(snapshot.events[0]?.payload)).toBe(true)
    })
  })

  it('captures event identities while checking the actual position at commit', async () => {
    await usingBackend(kind, async backend => {
      const writer = await backend.openWriter(id)
      const input = { ...event({ value: 1 }) }
      const first = writer.append(sessionLogPosition(0), input)
      const conflict = writer.append(sessionLogPosition(0), event({ value: 2 }))
      const outcomes = Promise.allSettled([first, conflict])
      input.sequence = sessionSequence(7)
      input.eventId = formatSessionEventId(id, input.sequence)

      expect(await outcomes).toEqual([
        { status: 'fulfilled', value: 1 },
        { status: 'rejected', reason: expect.objectContaining({ code: 'SESSION_POSITION_CONFLICT' }) },
      ])
      const snapshot = await writer.readCommitted()
      expect(snapshot).toMatchObject({ position: 1, events: [{ sequence: 1, payload: { value: 1 } }] })
    })
  })

  it('applies the record budget to the admitted content', async () => {
    await usingBackend(kind, async backend => {
      const writer = await backend.openWriter(id)
      const payload = { text: 'x'.repeat(5000) }
      const pending = writer.append(sessionLogPosition(0), event(payload))
      const rejected = expect(pending).rejects.toMatchObject({ code: 'SESSION_RECORD_TOO_LARGE' })
      payload.text = 'small'

      await rejected
      expect((await writer.readCommitted()).position).toBe(0)
      await expect(writer.append(sessionLogPosition(0), event(payload))).resolves.toBe(1)
    })
  })

  it('keeps earlier immutable read views stable after another commit', async () => {
    await usingBackend(kind, async backend => {
      const writer = await backend.openWriter(id)
      await writer.append(sessionLogPosition(0), event({ nested: { value: 1 } }))
      const earlier = await writer.readCommitted()
      const sequence = sessionSequence(2)
      await writer.append(sessionLogPosition(1), {
        ...event({ nested: { value: 2 } }), sequence, eventId: formatSessionEventId(id, sequence),
      })
      const later = await writer.readCommitted()

      expect(earlier).toMatchObject({ position: 1, events: [{ sequence: 1, payload: { nested: { value: 1 } } }] })
      expect(later.events).toHaveLength(2)
      expect(Object.isFrozen(earlier.events)).toBe(true)
      expect(Object.isFrozen(earlier.events[0])).toBe(true)
      expect(Object.isFrozen(earlier.events[0]?.payload)).toBe(true)
      expect(Object.isFrozen(later.events[0]?.payload)).toBe(true)
      expect(later.events[0]).toEqual(earlier.events[0])
      expect(later.events).not.toBe(earlier.events)
    })
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileSessionBackend,
  formatSessionAddress,
  formatSessionEventId,
  MemorySessionBackend,
  parseSessionId,
  sessionLogPosition,
  sessionSequence,
} from '../../src/index.js'
import type { SessionBackend, SessionHeader, StoredSessionEvent } from '../../src/index.js'

interface BackendFixture {
  readonly backend: SessionBackend
  readonly cleanup: () => Promise<void>
}

type BackendFactory = () => Promise<BackendFixture>

const factories: readonly [string, BackendFactory][] = [
  ['Memory', async () => ({
    backend: new MemorySessionBackend({ maxRecordBytes: 2048 }),
    cleanup: async () => undefined,
  })],
  ['File', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-harness-contract-'))
    return {
      backend: new FileSessionBackend({ root, maxRecordBytes: 2048 }),
      cleanup: async () => await rm(root, { recursive: true, force: true }),
    }
  }],
]

const firstId = parseSessionId('00000000-0000-4000-8000-000000000041')
const secondId = parseSessionId('00000000-0000-4000-8000-000000000042')

function header(sessionId = firstId): SessionHeader {
  return Object.freeze({
    formatVersion: 1,
    sessionId,
    address: formatSessionAddress(sessionId),
    createdAt: '2026-09-13T00:00:00.000Z',
  })
}

function event(sessionId = firstId, sequenceValue = 1): StoredSessionEvent {
  const sequence = sessionSequence(sequenceValue)
  return Object.freeze({
    envelopeVersion: 1,
    sessionId,
    eventId: formatSessionEventId(sessionId, sequence),
    sequence,
    recordedAt: '2026-09-13T00:00:01.000Z',
    type: 'contract/recorded',
    payloadVersion: 1,
    payload: Object.freeze({ value: sequenceValue }),
  })
}

async function usingBackend(
  factory: BackendFactory,
  run: (backend: SessionBackend) => Promise<void>,
): Promise<void> {
  const fixture = await factory()
  try {
    await run(fixture.backend)
  } finally {
    await fixture.backend.dispose().catch(() => undefined)
    await fixture.cleanup()
  }
}

describe.each(factories)('%s Session Backend contract', (_label, factory) => {
  it('creates, opens, appends, and reads an exact committed prefix', async () => {
    await usingBackend(factory, async backend => {
      await backend.create(header())
      await expect(backend.create(header())).rejects.toMatchObject({ code: 'SESSION_ALREADY_EXISTS' })
      const writer = await backend.openWriter(firstId)
      await expect(writer.append(sessionLogPosition(0), event())).resolves.toBe(1)
      await expect(backend.readPrefix(firstId, sessionLogPosition(0))).resolves.toMatchObject({
        position: 0,
        events: [],
      })
      await expect(backend.readPrefix(firstId)).resolves.toMatchObject({ position: 1 })
      await expect(backend.readPrefix(firstId, sessionLogPosition(2))).rejects.toMatchObject({
        code: 'SESSION_POSITION_INVALID',
      })
      await writer.dispose()
    })
  })

  it('enforces one writer per Session and expected-position commits', async () => {
    await usingBackend(factory, async backend => {
      await backend.create(header())
      const writer = await backend.openWriter(firstId)
      await expect(backend.openWriter(firstId)).rejects.toMatchObject({ code: 'SESSION_WRITE_LEASED' })
      await expect(writer.append(sessionLogPosition(1), event())).rejects.toMatchObject({
        code: 'SESSION_POSITION_CONFLICT',
      })
      expect((await writer.readCommitted()).position).toBe(0)
      await writer.dispose()
    })
  })

  it('rejects an oversized canonical event before changing its position', async () => {
    await usingBackend(factory, async backend => {
      await backend.create(header())
      const writer = await backend.openWriter(firstId)
      const oversized = Object.freeze({ ...event(), payload: Object.freeze({ text: 'x'.repeat(5_000) }) })
      await expect(writer.append(sessionLogPosition(0), oversized)).rejects.toMatchObject({
        code: 'SESSION_RECORD_TOO_LARGE',
      })
      expect((await writer.readCommitted()).position).toBe(0)
      await writer.dispose()
    })
  })

  it('allows different Session writers to commit independently', async () => {
    await usingBackend(factory, async backend => {
      await backend.create(header(firstId))
      await backend.create(header(secondId))
      const first = await backend.openWriter(firstId)
      const second = await backend.openWriter(secondId)
      await Promise.all([
        first.append(sessionLogPosition(0), event(firstId)),
        second.append(sessionLogPosition(0), event(secondId)),
      ])
      expect((await backend.readPrefix(firstId)).position).toBe(1)
      expect((await backend.readPrefix(secondId)).position).toBe(1)
      await Promise.all([first.dispose(), second.dispose()])
    })
  })

  it('returns copies whose mutation cannot alter stored records', async () => {
    await usingBackend(factory, async backend => {
      await backend.create(header())
      const writer = await backend.openWriter(firstId)
      await writer.append(sessionLogPosition(0), event())
      const read = await backend.readPrefix(firstId)
      expect(Object.isFrozen(read.events[0]?.payload)).toBe(true)
      expect(() => {
        ;(read.events[0]?.payload as { value: number }).value = 99
      }).toThrowError()
      expect((await backend.readPrefix(firstId)).events[0]?.payload).toEqual({ value: 1 })
      await writer.dispose()
    })
  })

  it('rejects work after Backend disposal', async () => {
    const fixture = await factory()
    try {
      await fixture.backend.create(header())
      await fixture.backend.dispose()
      await expect(fixture.backend.readPrefix(firstId)).rejects.toMatchObject({
        code: 'SESSION_REPOSITORY_INACTIVE',
      })
    } finally {
      await fixture.cleanup()
    }
  })
})

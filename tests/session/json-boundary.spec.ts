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
import type { JsonValue, SessionBackend, StoredSessionEvent } from '../../src/index.js'

const id = parseSessionId('00000000-0000-4000-8000-000000000133')

function event(payload: JsonValue): StoredSessionEvent {
  const sequence = sessionSequence(1)
  return {
    envelopeVersion: 1,
    sessionId: id,
    eventId: formatSessionEventId(id, sequence),
    sequence,
    recordedAt: '2026-10-10T00:00:01.000Z',
    type: 'boundary/recorded',
    payloadVersion: 1,
    payload,
  }
}

async function usingBackend(kind: 'Memory' | 'File', run: (backend: SessionBackend) => Promise<void>): Promise<void> {
  const temporaryParent = tmpdir()
  const root = kind === 'File' ? await mkdtemp(join(temporaryParent, 'atomic-harness-json-')) : undefined
  const backend: SessionBackend = root === undefined
    ? new MemorySessionBackend({ maxRecordBytes: 4096 })
    : new FileSessionBackend({ root, maxRecordBytes: 4096 })
  try {
    await backend.create({
      formatVersion: 1, sessionId: id, address: formatSessionAddress(id), createdAt: '2026-10-10T00:00:00.000Z',
    })
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

const invalidPayloads: readonly { readonly label: string; readonly make: () => JsonValue }[] = [
  { label: 'NaN', make: () => ({ value: Number.NaN }) },
  { label: 'positive Infinity', make: () => ({ values: [Number.POSITIVE_INFINITY] }) },
  { label: 'negative Infinity', make: () => ({ value: Number.NEGATIVE_INFINITY }) },
  { label: 'sparse arrays', make: () => {
    const values: number[] = []
    values.length = 2
    return values
  } },
  { label: 'cyclic records', make: () => {
    const value: { next: JsonValue } = { next: null }
    value.next = value
    return value
  } },
]

describe.each(['Memory', 'File'] as const)('%s stored JSON', kind => {
  it.each(invalidPayloads)('rejects $label before committing and keeps the Writer usable', async ({ make }) => {
    await usingBackend(kind, async backend => {
      const writer = await backend.openWriter(id)
      await expect(writer.append(sessionLogPosition(0), event(make()))).rejects.toMatchObject({
        code: 'SESSION_EVENT_INVALID',
      })
      expect((await writer.readCommitted()).position).toBe(0)
      await expect(writer.append(sessionLogPosition(0), event({ value: 1 }))).resolves.toBe(1)
      expect((await backend.readPrefix(id)).events[0]?.payload).toEqual({ value: 1 })
    })
  })

  it('rejects accessors without invoking them or exposing their payload', async () => {
    await usingBackend(kind, async backend => {
      const writer = await backend.openWriter(id)
      let reads = 0
      const payload = { get value(): string { reads += 1; return 'private-value' } }
      const error: unknown = await writer.append(sessionLogPosition(0), event(payload)).then(
        () => undefined,
        (reason: unknown) => reason,
      )

      expect(error).toMatchObject({ code: 'SESSION_EVENT_INVALID' })
      expect(reads).toBe(0)
      expect(JSON.stringify(error)).not.toContain('private-value')
      expect((await writer.readCommitted()).position).toBe(0)
      await expect(writer.append(sessionLogPosition(0), event({ value: 'safe' }))).resolves.toBe(1)
    })
  })
})

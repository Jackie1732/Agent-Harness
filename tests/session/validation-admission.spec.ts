import { describe, expect, it } from 'vitest'
import {
  formatSessionAddress,
  formatSessionEventId,
  MemorySessionBackend,
  parseSessionId,
  sessionLogPosition,
  sessionSequence,
} from '../../src/index.js'
import type { SessionWriter } from '../../src/index.js'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'

const id = parseSessionId('00000000-0000-4000-8000-000000000091')

async function storedBackend() {
  const backend = new MemorySessionBackend({ maxRecordBytes: 4096 })
  await backend.create({ formatVersion: 1, sessionId: id, address: formatSessionAddress(id), createdAt: '2026-10-10T00:00:00.000Z' })
  const writer = await backend.openWriter(id)
  await writer.append(sessionLogPosition(0), { envelopeVersion: 1, sessionId: id, eventId: formatSessionEventId(id, sessionSequence(1)),
    sequence: sessionSequence(1), recordedAt: '2026-10-10T00:00:01.000Z', type: 'test/recorded', payloadVersion: 1, payload: { value: 1 } })
  await writer.dispose()
  return backend
}

describe('Memory Writer committed validation', () => {
  it('validates a frozen committed prefix before publishing its Writer', async () => {
    const backend = await storedBackend()
    let validated = false
    try {
      const writer = await backend.openWriter(id, local => {
        validated = true
        expect(local).toMatchObject({ header: { sessionId: id }, position: 1, events: [{ payload: { value: 1 } }] })
        expect(Object.isFrozen(local)).toBe(true)
        expect(Object.isFrozen(local.events)).toBe(true)
        expect(Object.isFrozen(local.events[0]?.payload)).toBe(true)
      })
      expect(validated).toBe(true)
      expect((await writer.readCommitted()).position).toBe(1)
      await writer.dispose()
    } finally { await backend.dispose() }
  })

  it.each(['synchronous', 'asynchronous'] as const)('preserves %s validation failure and releases the candidate lease', async mode => {
    const backend = await storedBackend(), failure = new Error('semantic validation failed')
    try {
      const validation = mode === 'synchronous' ? () => { throw failure }
        : async () => { await Promise.resolve(); throw failure }
      const candidate = backend.openWriter(id, validation)
      await expect(candidate).rejects.toBe(failure)
      const writer = await backend.openWriter(id)
      expect((await writer.readCommitted()).position).toBe(1)
      await writer.dispose()
    } finally { await backend.dispose() }
  })

  it('keeps validation inside the Writer lease and outside the Reader gate', async () => {
    const backend = await storedBackend()
    const release = createDeferred<void>()
    let validating = false, published: SessionWriter | undefined
    const candidate = backend.openWriter(id, async () => { validating = true; await release.promise })
    void candidate.then(writer => { published = writer }, () => undefined)
    try {
      await drainMicrotasks(12)
      expect(validating).toBe(true)
      expect(published).toBeUndefined()
      let readCompleted = false
      const reading = backend.readPrefix(id).then(local => { readCompleted = true; return local })
      const competing = backend.openWriter(id)
      await drainMicrotasks(12)
      expect(readCompleted).toBe(true)
      expect((await reading).position).toBe(1)
      await expect(competing).rejects.toMatchObject({ code: 'SESSION_WRITE_LEASED' })
      release.resolve()
      const writer = await candidate
      expect(published).toBe(writer)
      await writer.dispose()
    } finally {
      release.resolve()
      await candidate.then(writer => writer.dispose(), () => undefined)
      await backend.dispose()
    }
  })

  it('rejects a candidate completed after Backend disposal without publishing a Writer', async () => {
    const backend = await storedBackend(), release = createDeferred<void>()
    let validating = false
    const candidate = backend.openWriter(id, async () => { validating = true; await release.promise })
    void candidate.catch(() => undefined)
    try {
      await drainMicrotasks(12)
      expect(validating).toBe(true)
      await backend.dispose()
      release.resolve()
      await expect(candidate).rejects.toMatchObject({ code: 'SESSION_REPOSITORY_INACTIVE' })
      await expect(backend.openWriter(id)).rejects.toMatchObject({ code: 'SESSION_REPOSITORY_INACTIVE' })
    } finally {
      release.resolve()
      await candidate.then(writer => writer.dispose(), () => undefined)
      await backend.dispose()
    }
  })
})

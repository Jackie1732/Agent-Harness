import { describe, expect, it } from 'vitest'
import { EffectDisposalFailedError } from '../../src/effect/errors.js'
import { createDurableEventCatalog } from '../../src/session/event-catalog.js'
import { SessionError } from '../../src/session/errors.js'
import { parseSessionId } from '../../src/session/ids.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import type { SessionBackend } from '../../src/session/backend.js'
import { firstId, identities, secondId } from './fixtures.js'

async function failedRead(operation: 'open' | 'create' | 'fork', cleanupFails: boolean) {
  const inner = new MemorySessionBackend({ maxRecordBytes: 4096 })
  const readFailure = new SessionError('SESSION_LOG_INVALID', 'committed Session read failed')
  const cleanupFailure = new Error('writer close failed')
  let injectFailure = false, closeCalls = 0
  const backend: SessionBackend = {
    get maxRecordBytes() { return inner.maxRecordBytes },
    create: header => inner.create(header),
    openWriter: async (sessionId, validateCommitted) => {
      const writer = await inner.openWriter(sessionId, validateCommitted)
      const failing = injectFailure
      return {
        header: writer.header,
        readCommitted: async () => {
          if (failing) throw readFailure
          return writer.readCommitted()
        },
        append: (position, event) => writer.append(position, event),
        dispose: async () => {
          if (failing) closeCalls++
          await writer.dispose()
          if (failing && cleanupFails) throw cleanupFailure
        },
      }
    },
    readPrefix: (sessionId, through) => inner.readPrefix(sessionId, through),
    dispose: () => inner.dispose(),
  }
  const repository = new SessionRepository({ backend, catalog: createDurableEventCatalog(),
    maxLineageDepth: 2, identitySource: identities(firstId, secondId) })
  const source = await repository.create()
  await source.dispose()
  injectFailure = true
  const acquire = () => operation === 'open' ? repository.open(source.header.sessionId)
    : operation === 'create' ? repository.create({ sessionId: parseSessionId(secondId) })
      : repository.fork(source.header.sessionId)
  return { repository, acquire, readFailure, cleanupFailure, closeCalls: () => closeCalls }
}

describe('Session acquisition failure and Writer release', () => {
  it.each(['open', 'create', 'fork'] as const)('keeps %s read and cleanup failures without retrying release', async operation => {
    const fixture = await failedRead(operation, true)
    try {
      const failure = await fixture.acquire().catch((reason: unknown) => reason)
      expect(failure).toBeInstanceOf(AggregateError)
      const combined = failure as AggregateError
      expect(combined.cause).toBe(fixture.readFailure)
      expect(combined.errors).toHaveLength(2)
      expect(combined.errors[0]).toBe(fixture.readFailure)
      const cleanup = combined.errors[1] as EffectDisposalFailedError
      expect(cleanup).toBeInstanceOf(EffectDisposalFailedError)
      expect(cleanup.cleanupFailures).toEqual([{ operationLabel: 'open Session writer', stage: 'revert', reason: fixture.cleanupFailure }])
      expect(cleanup).not.toHaveProperty('cause')
      expect(fixture.closeCalls()).toBe(1)

      const disposal = fixture.repository.dispose()
      expect(fixture.repository.dispose()).toBe(disposal)
      const disposalFailure = await disposal.catch((reason: unknown) => reason)
      expect(disposalFailure).toBeInstanceOf(AggregateError)
      const ownerFailure = (disposalFailure as AggregateError).errors[0] as EffectDisposalFailedError
      expect(ownerFailure).toBeInstanceOf(EffectDisposalFailedError)
      expect(ownerFailure.cleanupFailures[0]?.reason).toBe(fixture.cleanupFailure)
      await expect(fixture.repository.dispose()).rejects.toBe(disposalFailure)
      expect(fixture.closeCalls()).toBe(1)
      await expect(fixture.repository.open(parseSessionId(firstId))).rejects.toMatchObject({ code: 'SESSION_REPOSITORY_INACTIVE' })
    } finally { await fixture.repository.dispose().catch(() => undefined) }
  })

  it.each(['open', 'create', 'fork'] as const)('keeps the original %s failure when Writer release succeeds', async operation => {
    const fixture = await failedRead(operation, false)
    try {
      await expect(fixture.acquire()).rejects.toBe(fixture.readFailure)
      expect(fixture.closeCalls()).toBe(1)
      await fixture.repository.dispose()
      expect(fixture.closeCalls()).toBe(1)
    } finally { await fixture.repository.dispose() }
  })
})

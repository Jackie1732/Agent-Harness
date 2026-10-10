import { describe, expect, it } from 'vitest'
import { createDurableEventCatalog, MemorySessionBackend, SessionRepository } from '../../src/index.js'
import type { SessionBackend } from '../../src/index.js'
import { EffectDisposalFailedError } from '../../src/effect/errors.js'
import { firstId, identities, secondId } from './fixtures.js'

describe('Repository Writer cleanup ownership', () => {
  it.each([false, true])('reports each Writer inverse once with independent close=%s', async closeFirst => {
    const inner = new MemorySessionBackend({ maxRecordBytes: 4096 })
    const reasons = [new Error('first Writer close failed'), new Error('second Writer close failed')]
    const backendFailure = new Error('Backend release failed')
    const closes: string[] = []
    let backendDisposals = 0
    const backend: SessionBackend = {
      maxRecordBytes: inner.maxRecordBytes,
      create: header => inner.create(header), readPrefix: (id, through) => inner.readPrefix(id, through),
      openWriter: async (id, validateCommitted) => {
        const writer = await inner.openWriter(id, validateCommitted)
        return { ...writer, dispose: async () => {
          closes.push(id)
          await writer.dispose()
          throw reasons[id === firstId ? 0 : 1]
        } }
      },
      dispose: async () => { backendDisposals++; await inner.dispose(); throw backendFailure },
    }
    const repository = new SessionRepository({ backend, catalog: createDurableEventCatalog(), maxLineageDepth: 1,
      identitySource: identities(firstId, secondId) })
    const first = await repository.create()
    await repository.create()
    if (closeFirst) await expect(first.dispose()).rejects.toBeInstanceOf(EffectDisposalFailedError)
    const disposal = repository.dispose()
    expect(repository.dispose()).toBe(disposal)
    const failure = await disposal.catch((reason: unknown) => reason)
    expect(failure).toBeInstanceOf(AggregateError)
    const errors = (failure as AggregateError).errors
    expect(errors).toHaveLength(2)
    expect(errors[0]).toBeInstanceOf(EffectDisposalFailedError)
    expect((errors[0] as EffectDisposalFailedError).cleanupFailures.map(item => item.reason)).toEqual([reasons[1], reasons[0]])
    expect(errors[1]).toBe(backendFailure)
    expect(new Set(closes)).toEqual(new Set([firstId, secondId]))
    expect(closes).toHaveLength(2)
    expect(backendDisposals).toBe(1)
    await expect(repository.dispose()).rejects.toBe(failure)
    expect(closes).toHaveLength(2)
  })
})

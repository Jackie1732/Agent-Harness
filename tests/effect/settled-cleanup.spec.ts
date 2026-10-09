import { expect, it } from 'vitest'
import { EffectOwner } from '../../src/effect/owner.js'
import { EffectDisposalFailedError, EffectReentrantDisposeError } from '../../src/effect/errors.js'
import type { EffectLease } from '../../src/effect/types.js'
import { createDeferred } from '../helpers/deferred.js'

it('joins an already settled newer Lease from an older global inverse', async () => {
  const owner = new EffectOwner('shared-resources'), trace: string[] = []
  let newer!: EffectLease<void>
  await owner.run('older', async effect => {
    await effect.apply('older-resource', () => undefined, async () => {
      trace.push('older:started')
      const joined = newer.dispose()
      expect(newer.dispose()).toBe(joined)
      await joined
      trace.push('older:joined')
    })
  })
  newer = await owner.run('newer', async effect => {
    await effect.apply('newer-resource', () => undefined, () => { trace.push('newer:released') })
  })
  try {
    await expect(owner.dispose()).resolves.toBeUndefined()
    expect(trace).toEqual(['newer:released', 'older:started', 'older:joined'])
    await newer.dispose()
    expect(trace).toHaveLength(3)
  } finally { await owner.dispose().catch(() => undefined) }
})

it('observes a settled newer inverse failure without replacing it with a wait-cycle failure', async () => {
  const owner = new EffectOwner('failed-newer-resource'), reason = new Error('newer inverse failed')
  let newer!: EffectLease<void>, observed: unknown
  let attempts = 0, olderCompleted = false
  await owner.run('older', async effect => {
    await effect.apply('older-resource', () => undefined, async () => {
      observed = await newer.dispose().catch((error: unknown) => error)
      olderCompleted = true
    })
  })
  newer = await owner.run('newer', async effect => {
    await effect.apply('newer-resource', () => undefined, () => { attempts++; throw reason })
  })
  try {
    const failure = await owner.dispose().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(EffectDisposalFailedError)
    expect((failure as EffectDisposalFailedError).cleanupFailures).toHaveLength(1)
    expect((failure as EffectDisposalFailedError).cleanupFailures[0]?.reason).toBe(reason)
    expect(observed).toBeInstanceOf(EffectDisposalFailedError)
    expect((observed as EffectDisposalFailedError).cleanupFailures[0]?.reason).toBe(reason)
    expect(olderCompleted).toBe(true)
    expect(await newer.dispose().catch((error: unknown) => error)).toBe(observed)
    expect(attempts).toBe(1)
  } finally { await owner.dispose().catch(() => undefined) }
})

it('rejects joining a partially settled Lease whose older inverse is still queued by the current release', async () => {
  const owner = new EffectOwner('interleaved-resources'), trace: string[] = []
  const baseAccepted = createDeferred<void>(), addTop = createDeferred<void>()
  let composite!: EffectLease<void>
  const startup = owner.run('composite', async effect => {
    await effect.apply('base-resource', () => undefined, () => { trace.push('base:released') })
    baseAccepted.resolve()
    await addTop.promise
    await effect.apply('top-resource', () => undefined, () => { trace.push('top:released') })
  })
  try {
    await baseAccepted.promise
    await owner.run('middle', async effect => {
      await effect.apply('middle-resource', () => undefined, () => {
        trace.push('middle:started')
        expect(() => { void composite.dispose().catch(() => undefined) }).toThrow(EffectReentrantDisposeError)
        trace.push('middle:cycle-rejected')
      })
    })
    addTop.resolve()
    composite = await startup
    await expect(owner.dispose()).resolves.toBeUndefined()
    expect(trace).toEqual(['top:released', 'middle:started', 'middle:cycle-rejected', 'base:released'])
    await composite.dispose()
    expect(trace).toHaveLength(4)
  } finally {
    addTop.resolve()
    await startup.catch(() => undefined)
    await owner.dispose().catch(() => undefined)
  }
})

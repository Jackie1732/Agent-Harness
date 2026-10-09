import { expect, it } from 'vitest'
import { EffectDisposalFailedError, EffectOwner } from '../../src/index.js'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'

it.each(['active', 'settled'] as const)(
  'reports failures by target reverse acceptance order when an earlier Lease batch is %s',
  async previousBatch => {
    const owner = new EffectOwner('cached-order')
    const baseAccepted = createDeferred<void>(), addTop = createDeferred<void>()
    const topStarted = createDeferred<void>(), finishTop = createDeferred<void>()
    const baseStarted = createDeferred<void>(), finishBase = createDeferred<void>()
    const middleStarted = createDeferred<void>()
    const trace: string[] = []
    const reasons = new Map(['base', 'middle', 'top'].map(label => [label, new Error(label)]))
    const startup = owner.run('composite', async effect => {
      await effect.apply('base', () => 'base', async value => {
        trace.push(`${value}:start`)
        baseStarted.resolve()
        await finishBase.promise
        trace.push(`${value}:end`)
        throw reasons.get(value)
      })
      baseAccepted.resolve()
      await addTop.promise
      await effect.apply('top', () => 'top', async value => {
        trace.push(`${value}:start`)
        topStarted.resolve()
        await finishTop.promise
        trace.push(`${value}:end`)
        throw reasons.get(value)
      })
    })
    await baseAccepted.promise
    await owner.run('middle', async effect => {
      await effect.apply('middle', () => 'middle', value => {
        trace.push(`${value}:start`)
        middleStarted.resolve()
        throw reasons.get(value)
      })
    })
    addTop.resolve()
    const composite = await startup
    const leaseTask = composite.dispose(), leaseOutcome = leaseTask.catch((reason: unknown) => reason)
    await topStarted.promise
    let disposalOutcome: Promise<unknown> | undefined
    try {
      if (previousBatch === 'settled') {
        finishTop.resolve()
        await baseStarted.promise
        finishBase.resolve()
        await leaseOutcome
      }
      const disposal = owner.dispose()
      disposalOutcome = disposal.catch((reason: unknown) => reason)
      if (previousBatch === 'active') {
        await drainMicrotasks(16)
        expect(trace).toEqual(['top:start'])
        finishTop.resolve()
        await Promise.all([baseStarted.promise, middleStarted.promise])
        expect(trace).toEqual(['top:start', 'top:end', 'base:start', 'middle:start'])
        finishBase.resolve()
      }
      const [leaseError, ownerError] = await Promise.all([leaseOutcome, disposalOutcome])
      expect(leaseError).toBeInstanceOf(EffectDisposalFailedError)
      expect(ownerError).toBeInstanceOf(EffectDisposalFailedError)
      expect((leaseError as EffectDisposalFailedError).cleanupFailures.map(item => item.operationLabel)).toEqual(['top', 'base'])
      expect((ownerError as EffectDisposalFailedError).cleanupFailures.map(item => item.operationLabel)).toEqual(['top', 'middle', 'base'])
      for (const failure of (ownerError as EffectDisposalFailedError).cleanupFailures) {
        expect(failure.reason).toBe(reasons.get(failure.operationLabel!))
      }
      expect(trace.filter(item => item.endsWith(':start'))).toEqual(['top:start', 'base:start', 'middle:start'])
      expect(composite.dispose()).toBe(leaseTask)
      expect(await composite.dispose().catch((reason: unknown) => reason)).toBe(leaseError)
      expect(owner.dispose()).toBe(disposal)
      expect(await owner.dispose().catch((reason: unknown) => reason)).toBe(ownerError)
      expect(trace.filter(item => item.endsWith(':start'))).toHaveLength(3)
      expect(owner.status).toBe('disposed')
    } finally {
      finishTop.resolve()
      finishBase.resolve()
      await leaseOutcome
      await disposalOutcome
      await owner.dispose().catch(() => undefined)
    }
  },
)

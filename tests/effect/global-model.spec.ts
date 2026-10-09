import { expect, it } from 'vitest'
import { EffectDisposalFailedError, EffectOwner } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'

function permutations(values: readonly number[]): number[][] {
  if (values.length === 0) return [[]]
  return values.flatMap(value => permutations(values.filter(other => other !== value)).map(rest => [value, ...rest]))
}

it('preserves global serial LIFO and original failures across every four-operation acceptance order', async () => {
  for (const [trial, order] of permutations([0, 1, 2, 3]).entries()) {
    const owner = new EffectOwner(`global-model-${trial}`)
    const acquired = order.map(() => createDeferred<number>())
    const accepted = order.map(() => createDeferred<void>())
    const started = order.map(() => createDeferred<void>())
    const reverted = order.map(() => createDeferred<void>())
    const trace: number[] = []
    const failures = new Map([
      [trial % 4, new Error('first failure')],
      [(trial + 2) % 4, new Error('second failure')],
    ])
    const runs = [0, 1].map(group => owner.run(`effect-${group}`, async effect => {
      await Promise.all([group * 2, group * 2 + 1].map(async operation => {
        await effect.apply(`operation-${operation}`, () => acquired[operation]!.promise, async value => {
          trace.push(value)
          started[value]!.resolve()
          await reverted[value]!.promise
          if (failures.has(value)) throw failures.get(value)
        })
        accepted[operation]!.resolve()
      }))
    }))
    try {
      for (const operation of order) {
        acquired[operation]!.resolve(operation)
        await accepted[operation]!.promise
      }
      const leases = await Promise.all(runs)
      const disposal = owner.dispose()
      const outcome = disposal.catch((reason: unknown) => reason)
      const expected = [...order].reverse()
      for (const [index, operation] of expected.entries()) {
        await started[operation]!.promise
        expect(trace, `trial ${trial}, inverse ${operation}`).toEqual(expected.slice(0, index + 1))
        reverted[operation]!.resolve()
      }
      const error = await outcome
      expect(error).toBeInstanceOf(EffectDisposalFailedError)
      const cleanup = (error as EffectDisposalFailedError).cleanupFailures
      const failedOrder = expected.filter(operation => failures.has(operation))
      expect(cleanup.map(failure => failure.operationLabel)).toEqual(failedOrder.map(operation => `operation-${operation}`))
      cleanup.forEach((failure, index) => expect(failure.reason).toBe(failures.get(failedOrder[index]!)))
      expect(trace).toEqual(expected)
      expect(owner.dispose()).toBe(disposal)
      for (const [group, lease] of leases.entries()) {
        const localOutcome = lease.dispose().catch((reason: unknown) => reason)
        const local = await localOutcome
        const localFailures = failedOrder.filter(operation => Math.floor(operation / 2) === group)
        if (localFailures.length === 0) expect(local).toBeUndefined()
        else {
          expect(local).toBeInstanceOf(EffectDisposalFailedError)
          expect((local as EffectDisposalFailedError).cleanupFailures.map(failure => failure.reason))
            .toEqual(localFailures.map(operation => failures.get(operation)))
        }
      }
      expect(trace).toEqual(expected)
      expect(owner.status).toBe('disposed')
    } finally {
      acquired.forEach((gate, index) => gate.resolve(index))
      reverted.forEach(gate => gate.resolve())
      await Promise.allSettled(runs)
      await owner.dispose().catch(() => undefined)
    }
  }
})

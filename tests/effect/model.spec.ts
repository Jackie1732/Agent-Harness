import { describe, expect, it } from 'vitest'
import { EffectOwner } from '../../src/index.js'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'

/**
 * Deterministic pseudo-random source.
 *
 * The tests generate shapes from this source instead of using `Math.random`, so a failing
 * trial is reproducible from its recorded seed.
 *
 * @param seed - Initial state of the generator.
 * @returns A function producing the next value in [0, 1).
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

interface OperationPlan {
  /** Label of the operation, unique inside one effect. */
  readonly label: string
  /** Settlement delay in microtask turns, which decides the acceptance order. */
  readonly delay: number
  /** Whether the inverse fails. */
  readonly revertFails: boolean
}

interface EffectPlan {
  /** Label of the effect, unique inside one owner. */
  readonly label: string
  readonly operations: readonly OperationPlan[]
}

interface Scenario {
  readonly label: string
  readonly effects: readonly EffectPlan[]
}

/**
 * Generate one scenario whose effects and operations settle in a deliberately mixed order.
 *
 * @param random - Random source for the scenario.
 * @param index - Index used to build unique labels.
 * @returns A scenario the test drives deterministically.
 */
function generateScenario(random: () => number, index: number): Scenario {
  const effectCount = 1 + Math.floor(random() * 3)
  const effects: EffectPlan[] = []
  for (let e = 0; e < effectCount; e += 1) {
    const operationCount = Math.floor(random() * 4)
    const operations: OperationPlan[] = []
    for (let o = 0; o < operationCount; o += 1) {
      operations.push({
        label: `e${e}-op${o}`,
        delay: Math.floor(random() * 3),
        revertFails: random() < 0.35,
      })
    }
    effects.push({ label: `e${e}`, operations })
  }
  return { label: `seed-${index}`, effects }
}

describe('effect lifecycle model properties', () => {
  it('matches a reference model over generated scenarios', async () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const scenario = generateScenario(createRandom(seed), seed)
      const owner = new EffectOwner(scenario.label)
      // Acceptance order is recorded per effect, because each effect runs its own cleanup
      // batch: the traces concatenate, so only the order inside one batch is comparable.
      const acceptedByEffect = new Map<string, string[]>()
      const attempts = new Map<string, number>()
      const executed: string[] = []

      const runs = scenario.effects.map(effectPlan => owner.run(effectPlan.label, async effect => {
        const accepted: string[] = []
        acceptedByEffect.set(effectPlan.label, accepted)
        for (const operation of effectPlan.operations) {
          await effect.apply(operation.label, async () => {
            for (let turn = 0; turn <= operation.delay; turn += 1) {
              await Promise.resolve()
            }
            accepted.push(operation.label)
            return operation.label
          }, value => {
            attempts.set(value, (attempts.get(value) ?? 0) + 1)
            if (operation.revertFails) throw new Error(`revert failed for ${value}`)
            executed.push(value)
          })
        }
        return effectPlan.label
      }))

      const leases = await Promise.all(runs)
      expect(leases.map(lease => lease.value)).toEqual(scenario.effects.map(effect => effect.label))

      await Promise.all(leases.map(lease => lease.dispose().catch(() => undefined)))

      const allOperations = scenario.effects.flatMap(effect => effect.operations)
      const acceptanceOf = (label: string): number | undefined =>
        allOperations.findIndex(operation => operation.label === label)
      const failsInverse = (label: string): boolean =>
        allOperations[acceptanceOf(label)!]!.revertFails

      // Every accepted inverse ran at most once, and the attempted set is exactly the
      // accepted set.
      for (const operation of allOperations) {
        expect(attempts.get(operation.label) ?? 0).toBeLessThanOrEqual(1)
      }
      const acceptedLabels = [...acceptedByEffect.values()].flat()
      expect([...attempts.keys()].sort()).toEqual([...acceptedLabels].sort())

      // Inside each batch the successful inverses ran in the reverse of the acceptance
      // order, and the failing ones were still attempted. Batches concatenate, so the
      // trace is read one contiguous run per effect.
      const expectedPerEffect = new Map(
        [...acceptedByEffect.entries()].map(([label, accepted]) => [
          label,
          [...accepted].reverse().filter(operationLabel => !failsInverse(operationLabel)),
        ]),
      )
      for (const [effectLabel, expected] of expectedPerEffect) {
        const run = executed.filter(label => acceptedByEffect.get(effectLabel)!.includes(label))
        expect(run).toEqual(expected)
      }

      await owner.dispose().catch(() => undefined)
      expect(owner.status).toBe('disposed')
    }
  })

  it('runs no inverse of a local rollback for another effect records', async () => {
    const owner = new EffectOwner('isolation')
    const executed: string[] = []

    const survivor = await owner.run('survivor', async effect => {
      await effect.apply('survivor-op', () => 'a', value => {
        executed.push(value)
      })
    })

    await owner.run('failing', async effect => {
      await effect.apply('failing-op', () => 'b', value => {
        executed.push(value)
      })
      throw new Error('startup failed')
    }).catch(() => undefined)

    // Only the failing effect rolled back; the survivor keeps its record.
    expect(executed).toEqual(['b'])
    await survivor.dispose()
    expect(executed).toEqual(['b', 'a'])
  })

  it('starts no new work once the owner release has settled', async () => {
    const owner = new EffectOwner('quiescent')
    let setups = 0
    let operations = 0

    await owner.dispose()

    await owner.run('after', async effect => {
      setups += 1
      await effect.apply('op', () => {
        operations += 1
        return 'value'
      }, () => {})
    }).catch(() => undefined)

    expect(setups).toBe(0)
    expect(operations).toBe(0)
    expect(owner.status).toBe('disposed')
  })

  it('tries every later record even when an earlier inverse fails', async () => {
    const owner = new EffectOwner('failure-order')
    const attempted: string[] = []
    const lease = await owner.run('effect', async effect => {
      for (const name of ['first', 'second', 'third']) {
        await effect.apply(name, () => name, value => {
          attempted.push(value)
          if (value === 'third') throw new Error('third fails')
        })
      }
    })

    await lease.dispose().catch(() => undefined)

    // Reverse acceptance order, with the failing inverse not stopping the rest.
    expect(attempted).toEqual(['third', 'second', 'first'])
  })

  it('attempts each accepted inverse exactly once across mixed release paths', async () => {
    const owner = new EffectOwner('mixed-release')
    const attempts = new Map<string, number>()

    const leases = await Promise.all(['a', 'b'].map(label => owner.run(label, async effect => {
      await effect.apply(`${label}-op`, () => label, value => {
        attempts.set(value, (attempts.get(value) ?? 0) + 1)
      })
    })))

    // One effect releases through its lease, the other through the owner release.
    const mixed = await Promise.all([
      leases[0]!.dispose(),
      owner.dispose(),
      leases[1]!.dispose(),
    ])
    expect(mixed).toEqual([undefined, undefined, undefined])

    expect(attempts.get('a')).toBe(1)
    expect(attempts.get('b')).toBe(1)
    expect(owner.status).toBe('disposed')

    await drainMicrotasks()
    expect(attempts.get('a')).toBe(1)
    expect(attempts.get('b')).toBe(1)
  })

  it('holds the startup checkpoint until an admitted operation that setup left pending settles', async () => {
    const trace: string[] = []
    const gate = createDeferred<string>()
    const started = createDeferred<void>()
    const owner = new EffectOwner('checkpoint-wait')

    let settled = false
    const running = owner.run('effect', effect => {
      // Started and never awaited; a rejection carries no owner here, so it is ignored.
      void effect.apply('op', () => {
        started.resolve()
        return gate.promise
      }, value => {
        trace.push(`revert:${value}`)
      }).catch(() => undefined)
      return 'setup-finished'
    })
    void running.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    await started.promise
    await drainMicrotasks()
    // Setup finished, but the admitted operation has not, so no lease is handed out yet.
    expect(settled).toBe(false)

    gate.resolve('accepted')
    const outcome = await running
    expect(outcome.value).toBe('setup-finished')
    // The operation was admitted after the checkpoint registered its records, so the
    // successful run leaves it to the owner release rather than recovering it here.
    expect(trace).toEqual([])

    await owner.dispose()
    expect(trace).toEqual(['revert:accepted'])
  })

  it('recovers an admitted operation when the owner releases before the checkpoint', async () => {
    const trace: string[] = []
    const gate = createDeferred<string>()
    const started = createDeferred<void>()
    const owner = new EffectOwner('checkpoint-interrupt')

    const running = owner.run('effect', effect => {
      void effect.apply('op', () => {
        started.resolve()
        return gate.promise
      }, value => {
        trace.push(`revert:${value}`)
      }).catch(() => undefined)
      // Keeps setup open so the release lands while the operation is still pending.
      return gate.promise.then(() => 'setup-finished')
    })
    await started.promise
    await drainMicrotasks()

    const disposal = owner.dispose()
    gate.resolve('accepted')

    const reason = await running.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    await disposal

    expect((reason as { code?: string }).code).toBe('EFFECT_START_INTERRUPTED')
    expect(trace).toEqual(['revert:accepted'])
    expect(owner.status).toBe('disposed')
  })
})

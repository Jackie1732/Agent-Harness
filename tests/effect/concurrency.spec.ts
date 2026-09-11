import { describe, expect, it } from 'vitest'
import { EffectOwner } from '../../src/index.js'
import type { EffectContext } from '../../src/index.js'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'

/**
 * Read the stable error code from a value that may be a thrown error or a cleanup failure.
 *
 * @param candidate - Candidate error, error-like value, or cleanup failure list.
 * @returns The stable error code when one is present.
 */
function findReentrantCode(candidate: unknown): string | undefined {
  if (candidate === undefined || candidate === null) return undefined
  const failures = (candidate as { cleanupFailures?: readonly { reason: unknown }[] }).cleanupFailures
  for (const failure of failures ?? []) {
    const code = findReentrantCode(failure.reason)
    if (code !== undefined) return code
  }
  return (candidate as { code?: string }).code
}

describe('effect disposal idempotence and races', () => {
  it('runs each inverse at most once across repeated and concurrent lease releases', async () => {
    const counts = new Map<string, number>()
    const owner = new EffectOwner('idempotent')
    const lease = await owner.run('effect', async effect => {
      for (const name of ['alpha', 'beta']) {
        await effect.apply(name, () => name, value => {
          counts.set(value, (counts.get(value) ?? 0) + 1)
        })
      }
    })

    await Promise.all([lease.dispose(), lease.dispose(), lease.dispose()])
    await lease.dispose()

    expect(counts.get('alpha')).toBe(1)
    expect(counts.get('beta')).toBe(1)
  })

  it('shares one cleanup task between a lease and an owner release', async () => {
    const counts = new Map<string, number>()
    const owner = new EffectOwner('shared-task')
    const lease = await owner.run('effect', async effect => {
      await effect.apply('alpha', () => 'alpha', value => {
        counts.set(value, (counts.get(value) ?? 0) + 1)
      })
    })

    // Both releases target the same accepted inverse at the same time.
    const results = await Promise.all([
      lease.dispose(),
      owner.dispose(),
      owner.dispose(),
    ])

    expect(results).toEqual([undefined, undefined, undefined])
    expect(counts.get('alpha')).toBe(1)
    expect(owner.status).toBe('disposed')
  })

  it('returns one shared promise from repeated owner releases', async () => {
    const owner = new EffectOwner('shared-promise')
    const first = owner.dispose()
    const second = owner.dispose()
    const third = owner.dispose()

    expect(second).toBe(first)
    expect(third).toBe(first)
    await first
    expect(owner.dispose()).toBe(first)
    expect(owner.status).toBe('disposed')
  })

  it('returns one shared promise from repeated lease releases', async () => {
    const owner = new EffectOwner('shared-lease-promise')
    const lease = await owner.run('effect', () => 'value')

    const first = lease.dispose()
    const second = lease.dispose()
    expect(second).toBe(first)
    await first
    expect(lease.dispose()).toBe(first)
  })

  it('waits for an asynchronous inverse before settling the release', async () => {
    const gate = createDeferred<void>()
    let resolved = false
    const owner = new EffectOwner('async-inverse')
    const lease = await owner.run('effect', async effect => {
      await effect.apply('op', () => 'value', async () => {
        await gate.promise
        resolved = true
      })
    })

    let settled = false
    const disposal = lease.dispose().then(() => {
      settled = true
    })

    await drainMicrotasks()
    expect(settled).toBe(false)
    expect(resolved).toBe(false)

    gate.resolve()
    await disposal
    expect(settled).toBe(true)
    expect(resolved).toBe(true)
  })

  it('rejects new runs without calling setup after release started', async () => {
    const owner = new EffectOwner('closed')
    let setups = 0
    const close = owner.dispose()

    const outcome = await owner.run('late', () => {
      setups += 1
      return 'never'
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(setups).toBe(0)
    expect((outcome as { code?: string }).code).toBe('EFFECT_OWNER_INACTIVE')
    await close
    expect(owner.status).toBe('disposed')
  })

  it('rejects new operations without running them after release started', async () => {
    const owner = new EffectOwner('closed-ops')
    let operations = 0
    const gate = createDeferred<void>()

    const running = owner.run('effect', async effect => {
      await gate.promise
      await effect.apply('late-op', () => {
        operations += 1
        return 'never'
      }, () => {})
      return 'finished'
    })
    await drainMicrotasks()

    const disposal = owner.dispose()
    gate.resolve()

    const outcome = await running.then(
      () => undefined,
      (reason: unknown) => reason,
    )
    await disposal

    expect(operations).toBe(0)
    expect((outcome as { code?: string }).code).toBe('EFFECT_OWNER_INACTIVE')
  })

  it('rejects an operation requested after the effect stopped accepting', async () => {
    const owner = new EffectOwner('closed-effect')
    let reason: unknown
    let late: EffectContext | undefined

    const lease = await owner.run('effect', async effect => {
      late = effect
      return await effect.apply('op', () => 'value', () => {})
    })

    // The effect accepted its operations while setup ran and closed its entrance once it
    // finished, so a later request is rejected without running anything.
    await late!.apply('late-op', () => 'never', () => {}).catch((caught: unknown) => {
      reason = caught
    })

    expect(lease.value).toBe('value')
    expect((reason as { code?: string }).code).toBe('EFFECT_OWNER_INACTIVE')
    expect((reason as { requestLabel?: string }).requestLabel).toBe('late-op')
    await lease.dispose()
  })

  it('keeps dispose waiting until every tracked forward task has settled', async () => {
    const owner = new EffectOwner('tracked')
    const operationGate = createDeferred<string>()
    const setupGate = createDeferred<void>()
    const trace: string[] = []

    const running = owner.run('effect', async effect => {
      await effect.apply('op', () => operationGate.promise, value => {
        trace.push(`revert:${value}`)
      })
      // The effect is still starting when the release arrives.
      await setupGate.promise
      return 'finished'
    })
    await drainMicrotasks()

    let settled = false
    const disposal = owner.dispose().then(() => {
      settled = true
    })

    await drainMicrotasks()
    expect(settled).toBe(false)

    // The forward operation settles after the release began, so its inverse is still
    // accepted and applied before the release can finish.
    operationGate.resolve('accepted')
    await drainMicrotasks()
    expect(trace).toEqual([])
    expect(settled).toBe(false)

    setupGate.resolve()
    await running.catch(() => undefined)
    await disposal

    expect(settled).toBe(true)
    expect(trace).toEqual(['revert:accepted'])
  })

  it('tracks an operation that setup started without awaiting', async () => {
    const operationGate = createDeferred<string>()
    const operationStarted = createDeferred<void>()
    const trace: string[] = []
    const owner = new EffectOwner('unawaited-operation')

    const running = owner.run('effect', effect => {
      void effect.apply('op', () => {
        operationStarted.resolve()
        return operationGate.promise
      }, value => {
        trace.push(`revert:${value}`)
      })
      return 'setup-finished'
    })
    await operationStarted.promise

    let runSettled = false
    void running.then(
      () => { runSettled = true },
      () => { runSettled = true },
    )
    await drainMicrotasks()
    expect(runSettled).toBe(false)

    const disposal = owner.dispose()
    operationGate.resolve('accepted')

    await expect(running).rejects.toMatchObject({ code: 'EFFECT_START_INTERRUPTED' })
    await disposal
    expect(trace).toEqual(['revert:accepted'])
  })

  it('rejects a lease release awaited from inside its own inverse', async () => {
    const owner = new EffectOwner('lease-self-wait')
    let armed = false
    let captured: unknown

    const lease = await owner.run('effect', async effect =>
      effect.apply('op', () => 'value', async () => {
        if (!armed) return
        try {
          // Waiting for the release that is running this inverse would never settle.
          await lease.dispose()
        } catch (caught) {
          captured = caught
        }
      }))

    armed = true
    await lease.dispose().catch(() => undefined)

    expect(findReentrantCode(captured)).toBe('EFFECT_REENTRANT_DISPOSE')
    expect(owner.status).toBe('accepting')
  })

  it('rejects re-entering an owner release from its own inverse', async () => {
    const owner = new EffectOwner('owner-self-wait')
    let armed = false
    let captured: unknown

    const lease = await owner.run('effect', async effect =>
      effect.apply('op', () => 'value', async () => {
        if (!armed) return
        try {
          await owner.dispose()
        } catch (caught) {
          captured = caught
        }
      }))

    armed = true
    await owner.dispose().catch(() => undefined)
    await lease.dispose().catch(() => undefined)

    expect(findReentrantCode(captured)).toBe('EFFECT_REENTRANT_DISPOSE')
    expect(owner.status).toBe('disposed')
  })

  it('rejects an owner release that would wait for the current lease release', async () => {
    const owner = new EffectOwner('lease-owner-wait')
    let captured: unknown

    const lease = await owner.run('effect', async effect =>
      effect.apply('op', () => 'value', async () => {
        try {
          await owner.dispose()
        } catch (caught) {
          captured = caught
        }
      }))

    await lease.dispose()

    expect(findReentrantCode(captured)).toBe('EFFECT_REENTRANT_DISPOSE')
    expect(owner.status).toBe('accepting')
    await owner.dispose()
    expect(owner.status).toBe('disposed')
  })

  it('rejects a sibling lease release that would wait for the current owner release', async () => {
    const order: string[] = []
    const owner = new EffectOwner('owner-sibling-wait')
    let captured: unknown

    const older = await owner.run('older', async effect =>
      effect.apply('older-op', () => 'older', value => {
        order.push(value)
      }))
    await owner.run('newer', async effect =>
      effect.apply('newer-op', () => 'newer', async value => {
        order.push(value)
        try {
          await older.dispose()
        } catch (caught) {
          captured = caught
        }
      }))

    await owner.dispose()

    expect(findReentrantCode(captured)).toBe('EFFECT_REENTRANT_DISPOSE')
    expect(order).toEqual(['newer', 'older'])
    expect(owner.status).toBe('disposed')
  })

  it('allows an inverse to await a different owner release', async () => {
    const order: string[] = []
    const outer = new EffectOwner('outer')
    const inner = new EffectOwner('inner')

    const innerLease = await inner.run('inner-effect', async effect => {
      return await effect.apply('inner-op', () => 'inner', value => {
        order.push(`inner-revert:${value}`)
      })
    })
    expect(innerLease.value).toBe('inner')

    const outerLease = await outer.run('outer-effect', async effect => {
      await effect.apply('outer-op', () => 'outer', async value => {
        // Waiting for a different ownership scope is not self-waiting.
        await inner.dispose()
        order.push(`outer-revert:${value}`)
      })
    })

    await outerLease.dispose()
    expect(order).toEqual(['inner-revert:inner', 'outer-revert:outer'])
  })

  it('rejects a release cycle inherited across two owners', async () => {
    const first = new EffectOwner('first-owner')
    const second = new EffectOwner('second-owner')
    let captured: unknown

    await first.run('first-effect', async effect => {
      await effect.apply('first-op', () => 'first', async () => {
        await second.dispose()
      })
    })
    await second.run('second-effect', async effect => {
      await effect.apply('second-op', () => 'second', async () => {
        try {
          await first.dispose()
        } catch (caught) {
          captured = caught
        }
      })
    })

    await first.dispose()

    expect(findReentrantCode(captured)).toBe('EFFECT_REENTRANT_DISPOSE')
    expect(first.status).toBe('disposed')
    expect(second.status).toBe('disposed')
  })

  it('does not start a second release task when the target release is already active', async () => {
    const gate = createDeferred<void>()
    const counts = new Map<string, number>()
    const owner = new EffectOwner('single-task')
    const lease = await owner.run('effect', async effect => {
      await effect.apply('op', () => 'value', async value => {
        await gate.promise
        counts.set(value, (counts.get(value) ?? 0) + 1)
      })
    })

    const first = lease.dispose()
    await drainMicrotasks()
    const second = lease.dispose()
    expect(second).toBe(first)

    gate.resolve()
    await first
    expect(counts.get('value')).toBe(1)
  })
})

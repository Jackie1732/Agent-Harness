import { describe, expect, it } from 'vitest'
import {
  EffectDisposalFailedError,
  EffectRollbackFailedError,
  EffectOwner,
  isJsonValue,
} from '../../src/index.js'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'

describe('effect startup failure and rollback', () => {
  it('reverts only the operations the failing startup already accepted', async () => {
    const trace: string[] = []
    const owner = new EffectOwner('rollback')
    const failure = new Error('second operation failed')

    const outcome = await owner
      .run('effect', async effect => {
        await effect.apply('first', () => 'a', value => {
          trace.push(`revert:${value}`)
        })
        await effect.apply('second', () => {
          throw failure
        }, () => {
          trace.push('revert:second')
        })
      })
      .then(
        () => 'fulfilled',
        (reason: unknown) => reason,
      )

    expect(outcome).toBe(failure)
    expect(trace).toEqual(['revert:a'])
  })

  it('does not release a sibling effect when one startup fails', async () => {
    const trace: string[] = []
    const owner = new EffectOwner('siblings')

    const survivor = await owner.run('survivor', async effect => {
      await effect.apply('keep', () => 'kept', value => {
        trace.push(`revert:${value}`)
      })
    })

    await expect(owner.run('failing', async effect => {
      await effect.apply('abandoned', () => 'gone', value => {
        trace.push(`revert:${value}`)
      })
      throw new Error('startup failed')
    })).rejects.toThrow('startup failed')

    // The failing effect rolled back its own inverse and left the sibling untouched.
    expect(trace).toEqual(['revert:gone'])

    await survivor.dispose()
    expect(trace).toEqual(['revert:gone', 'revert:kept'])
  })

  it('preserves the original setup failure identity when rollback succeeds', async () => {
    const owner = new EffectOwner('identity')
    const failure = new TypeError('original failure')

    const reason = await owner.run('effect', async () => {
      throw failure
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(reason).toBe(failure)
  })

  it('reports a combined error when setup and rollback both fail', async () => {
    const owner = new EffectOwner('combined')
    const setupFailure = new Error('setup failed')
    const revertFailure = new Error('revert failed')

    const reason = await owner.run('effect', async effect => {
      await effect.apply('op', () => 'value', () => {
        throw revertFailure
      })
      throw setupFailure
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(reason).toBeInstanceOf(EffectRollbackFailedError)
    const error = reason as EffectRollbackFailedError
    expect(error.code).toBe('EFFECT_ROLLBACK_FAILED')
    expect(error.effectLabel).toBe('effect')
    expect(error.setupReason).toBe(setupFailure)
    expect(error.cause).toBe(setupFailure)
    expect(error.cleanupFailures).toHaveLength(1)
    expect(error.cleanupFailures[0]!.operationLabel).toBe('op')
    expect(error.cleanupFailures[0]!.reason).toBe(revertFailure)
  })

  it('continues with remaining inverses after one inverse fails', async () => {
    const trace: string[] = []
    const owner = new EffectOwner('continue')
    const revertFailure = new Error('middle revert failed')

    const lease = await owner.run('effect', async effect => {
      await effect.apply('first', () => 'a', value => {
        trace.push(value)
      })
      await effect.apply('second', () => 'b', () => {
        trace.push('b')
        throw revertFailure
      })
      await effect.apply('third', () => 'c', value => {
        trace.push(value)
      })
    })

    const reason = await lease.dispose().then(
      () => undefined,
      (caught: unknown) => caught,
    )

    // Reverse acceptance order, and the failure of "second" does not stop "first".
    expect(trace).toEqual(['c', 'b', 'a'])
    expect(reason).toBeDefined()
    expect((reason as { code?: string }).code).toBe('EFFECT_DISPOSAL_FAILED')
  })

  it('leaves observable resources partially recovered when an inverse fails', async () => {
    const active = new Set(['alpha', 'beta', 'gamma'])
    const attempts: string[] = []
    const owner = new EffectOwner('partial')

    const lease = await owner.run('effect', async effect => {
      for (const name of ['alpha', 'beta', 'gamma']) {
        await effect.apply(name, () => name, value => {
          attempts.push(value)
          if (value === 'beta') throw new Error('cannot release beta')
          active.delete(value)
        })
      }
    })

    await lease.dispose().catch(() => undefined)

    // Every inverse was attempted, the failing one left its resource in place, and the
    // records after it still ran.
    expect(attempts).toEqual(['gamma', 'beta', 'alpha'])
    expect([...active]).toEqual(['beta'])
  })

  it('reports cleanup attempt counts without asserting a completed recovery', async () => {
    const owner = new EffectOwner('diagnostics')
    const lease = await owner.run('effect', async effect => {
      await effect.apply('first', () => 'a', () => {
        throw new Error('first revert failed')
      })
      await effect.apply('second', () => 'b', () => {
        throw new Error('second revert failed')
      })
    })

    const reason = await lease.dispose().then(
      () => undefined,
      (caught: unknown) => caught,
    )
    const json = (reason as EffectDisposalFailedError).toJSON()

    expect(json.code).toBe('EFFECT_DISPOSAL_FAILED')
    expect(isJsonValue(json)).toBe(true)
    expect(json.details).toEqual({
      target: 'lease',
      effectLabel: 'effect',
      failedCount: 2,
      failures: [
        { operationLabel: 'second', stage: 'revert', reasonName: 'Error' },
        { operationLabel: 'first', stage: 'revert', reasonName: 'Error' },
      ],
    })
    // Failure order equals the order the inverses were attempted.
    const details = json.details as { failures: readonly { operationLabel: string }[] }
    expect(details.failures.map(failure => failure.operationLabel)).toEqual(['second', 'first'])
    // Nothing in the projection claims that the resources were recovered.
    for (const key of Object.keys(json.details ?? {})) {
      expect(key).not.toMatch(/recovered|restored|rolledBack|complete|cleaned/i)
    }
  })

  it('handles a synchronous throw inside an inverse as a recorded failure', async () => {
    const owner = new EffectOwner('sync-throw')
    const lease = await owner.run('effect', async effect => {
      await effect.apply('op', () => undefined, () => {
        throw new Error('synchronous revert failure')
      })
    })

    const reason = await lease.dispose().then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(reason).toBeDefined()
    expect((reason as { code?: string }).code).toBe('EFFECT_DISPOSAL_FAILED')
  })

  it('does not settle owner disposal while a forward operation is still unsettled', async () => {
    const trace: string[] = []
    const gate = createDeferred<string>()
    const owner = new EffectOwner('in-flight')
    let disposalSettled = false

    const running = owner.run('effect', async effect => {
      return await effect.apply('slow', () => gate.promise, value => {
        trace.push(`revert:${value}`)
      })
    })
    // The ownership shutdown arrives while the forward operation is still pending.
    const disposal = owner.dispose().then(() => {
      disposalSettled = true
    })

    await drainMicrotasks()
    expect(disposalSettled).toBe(false)

    gate.resolve('value')
    const outcome = await running.then(
      () => 'fulfilled',
      (reason: unknown) => reason,
    )

    // The operation settled after the owner stopped accepting work, so its result is not
    // handed to the caller and no inverse is accepted for it.
    expect((outcome as { code?: string }).code).toBe('EFFECT_OWNER_INACTIVE')
    await disposal
    expect(disposalSettled).toBe(true)
    expect(trace).toEqual([])
  })

  it('recovers an acquired resource when setup finishes after the owner started releasing', async () => {
    const trace: string[] = []
    const gate = createDeferred<void>()
    const owner = new EffectOwner('interrupted')

    const running = owner.run('effect', async effect => {
      await effect.apply('acquire', () => 'value', value => {
        trace.push(`revert:${value}`)
      })
      await gate.promise
      return 'setup-finished'
    })
    await drainMicrotasks()

    const disposal = owner.dispose()
    gate.resolve()

    const outcome = await running.then(
      () => 'fulfilled',
      (reason: unknown) => reason,
    )
    await disposal

    // Setup completed without requesting new work, so the final checkpoint interrupts the
    // effect and the resource it acquired is still recovered.
    expect((outcome as { code?: string }).code).toBe('EFFECT_START_INTERRUPTED')
    expect((outcome as { attempted?: number }).attempted).toBe(1)
    expect(trace).toEqual(['revert:value'])
  })

  it('reverts an interrupted effect exactly once when the owner sweeps afterwards', async () => {
    const trace: string[] = []
    const gate = createDeferred<void>()
    const owner = new EffectOwner('sibling-interrupt')

    const survivor = await owner.run('survivor', async effect => {
      return await effect.apply('keep', () => 'kept', value => {
        trace.push(`revert:${value}`)
      })
    })

    const interrupted = owner.run('interrupted', async () => {
      await gate.promise
      return 'finished'
    })
    await drainMicrotasks()

    // The interrupted effect rolls back locally while the survivor's inverse is still on
    // the owner's global stack, then the owner sweep must not run it a second time.
    const disposal = owner.dispose()
    gate.resolve()

    const outcome = await interrupted.then(
      () => 'fulfilled',
      (reason: unknown) => reason,
    )
    await disposal

    expect((outcome as { code?: string }).code).toBe('EFFECT_START_INTERRUPTED')
    expect(survivor.value).toBe('kept')
    expect(trace).toEqual(['revert:kept'])
    expect(owner.status).toBe('disposed')
  })
})

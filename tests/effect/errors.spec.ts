import { describe, expect, it } from 'vitest'
import {
  describeReasonName,
  EffectDisposalFailedError,
  EffectOwnerInactiveError,
  EffectOwner,
  EffectReentrantDisposeError,
  EffectRollbackFailedError,
  EffectStartInterruptedError,
  HarnessError,
  isJsonValue,
  projectCleanupFailures,
} from '../../src/index.js'
import type { EffectCleanupFailure } from '../../src/index.js'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'

describe('effect error model', () => {
  it('reports EFFECT_OWNER_INACTIVE with the request label and owner status', async () => {
    const owner = new EffectOwner('inactive-owner')
    const close = owner.dispose()

    const reason = await owner.run('late-effect', () => 'never').then(
      () => undefined,
      (caught: unknown) => caught,
    )
    await close

    expect(reason).toBeInstanceOf(EffectOwnerInactiveError)
    const error = reason as EffectOwnerInactiveError
    expect(error.code).toBe('EFFECT_OWNER_INACTIVE')
    expect(error.requestLabel).toBe('late-effect')
    expect(error.ownerStatus).toBe('disposing')
    expect(error.message).toContain('late-effect')
    expect(error.message).toContain('disposing')
    expect(isJsonValue(error.toJSON())).toBe(true)
  })

  it('reports EFFECT_OWNER_INACTIVE naming the released effect for a late operation', async () => {
    const owner = new EffectOwner('inactive-operation')
    const gate = createDeferred<void>()
    let reason: unknown

    const running = owner.run('effect', async effect => {
      await gate.promise
      try {
        await effect.apply('late-op', () => 'never', () => {})
      } catch (caught) {
        reason = caught
      }
      return 'finished'
    })
    await drainMicrotasks()

    const disposal = owner.dispose()
    gate.resolve()
    // The operation request is rejected while the owner releases, and the effect finishes
    // its startup only to be interrupted at the final checkpoint.
    const runReason = await running.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    await disposal

    expect((reason as { code?: string }).code).toBe('EFFECT_OWNER_INACTIVE')
    expect((reason as { requestLabel?: string }).requestLabel).toBe('late-op')
    expect((runReason as { code?: string }).code).toBe('EFFECT_START_INTERRUPTED')
  })

  it('reports EFFECT_START_INTERRUPTED with attempted and failed counts', async () => {
    const owner = new EffectOwner('interrupt')
    const gate = createDeferred<void>()

    const running = owner.run('effect', async effect => {
      await effect.apply('first', () => 'a', () => {})
      await effect.apply('second', () => 'b', () => {})
      await gate.promise
      return 'finished'
    })
    await drainMicrotasks()

    const disposal = owner.dispose()
    gate.resolve()

    const reason = await running.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    await disposal

    expect(reason).toBeInstanceOf(EffectStartInterruptedError)
    const error = reason as EffectStartInterruptedError
    expect(error.code).toBe('EFFECT_START_INTERRUPTED')
    expect(error.effectLabel).toBe('effect')
    expect(error.attempted).toBe(2)
    expect(error.failed).toBe(0)
    expect(error.message).toContain('effect')
    expect(error.message).toContain('2')

    const details = error.toJSON().details as { attempted: number; failedCount: number }
    expect(details.attempted).toBe(2)
    expect(details.failedCount).toBe(0)
  })

  it('reports a failed inverse once when startup is interrupted', async () => {
    const owner = new EffectOwner('interrupt-failed-rollback')
    const gate = createDeferred<void>()
    const revertFailure = new Error('rollback failed')
    let attempts = 0

    const running = owner.run('effect', async effect => {
      await effect.apply('op', () => 'a', () => {
        attempts += 1
        throw revertFailure
      })
      await gate.promise
      return 'finished'
    })
    await drainMicrotasks()

    const disposal = owner.dispose()
    gate.resolve()

    const reason = await running.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    // The owner sweep reaches the same inverse, so it reports the same failure as a
    // release that is incomplete rather than as a silent success.
    const disposalReason = await disposal.then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(reason).toBeInstanceOf(EffectRollbackFailedError)
    const rollback = reason as EffectRollbackFailedError
    expect(rollback.code).toBe('EFFECT_ROLLBACK_FAILED')
    expect(rollback.cause).toBeInstanceOf(EffectStartInterruptedError)
    expect(rollback.cleanupFailures).toHaveLength(1)
    expect(rollback.cleanupFailures[0]!.operationLabel).toBe('op')
    expect(rollback.cleanupFailures[0]!.reason).toBe(revertFailure)
    // Each accepted inverse is claimed once, so the two cleanup scopes did not run it twice.
    expect(attempts).toBe(1)

    expect(disposalReason).toBeInstanceOf(EffectDisposalFailedError)
    const disposalFailure = (disposalReason as EffectDisposalFailedError).cleanupFailures[0]!
    expect(disposalFailure.operationLabel).toBe('op')
    expect(disposalFailure.reason).toBe(revertFailure)
  })

  it('reports EFFECT_ROLLBACK_FAILED with the setup reason and ordered cleanup failures', async () => {
    const owner = new EffectOwner('rollback-failed')
    const setupFailure = new RangeError('setup failure')
    const firstRevert = new Error('first revert')
    const secondRevert = new TypeError('second revert')

    const reason = await owner.run('effect', async effect => {
      await effect.apply('first', () => 1, () => {
        throw firstRevert
      })
      await effect.apply('second', () => 2, () => {
        throw secondRevert
      })
      throw setupFailure
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    const error = reason as EffectRollbackFailedError
    expect(error.code).toBe('EFFECT_ROLLBACK_FAILED')
    expect(error.setupReason).toBe(setupFailure)
    expect(error.cause).toBe(setupFailure)
    expect(error.cleanupFailures.map(failure => failure.operationLabel)).toEqual(['second', 'first'])
    expect(error.cleanupFailures.map(failure => failure.reason)).toEqual([secondRevert, firstRevert])
    expect(isJsonValue(error.toJSON())).toBe(true)

    const details = error.toJSON().details as { failures: readonly { operationLabel: string }[] }
    expect(details.failures.map(failure => failure.operationLabel)).toEqual(['second', 'first'])
  })

  it('reports EFFECT_DISPOSAL_FAILED for lease and owner releases with distinct targets', async () => {
    const owner = new EffectOwner('disposal-failed')
    const lease = await owner.run('effect', async effect => {
      await effect.apply('op', () => 'value', () => {
        throw new Error('cannot revert')
      })
    })

    const leaseReason = await lease.dispose().then(
      () => undefined,
      (caught: unknown) => caught,
    )
    const leaseError = leaseReason as EffectDisposalFailedError
    expect(leaseError.code).toBe('EFFECT_DISPOSAL_FAILED')
    expect(leaseError.target).toBe('lease')
    expect(leaseError.effectLabel).toBe('effect')

    const ownerOwned = new EffectOwner('owner-disposal-failed')
    await ownerOwned.run('owner-effect', async effect => {
      await effect.apply('op', () => 'value', () => {
        throw new Error('cannot revert either')
      })
    })
    const ownerReason = await ownerOwned.dispose().then(
      () => undefined,
      (caught: unknown) => caught,
    )
    const ownerError = ownerReason as EffectDisposalFailedError
    expect(ownerError.code).toBe('EFFECT_DISPOSAL_FAILED')
    expect(ownerError.target).toBe('owner')
    expect(ownerError.effectLabel).toBeUndefined()
    expect(isJsonValue(ownerError.toJSON())).toBe(true)
  })

  it('reports EFFECT_REENTRANT_DISPOSE with the ownership chain labels', async () => {
    const owner = new EffectOwner('reentrant-owner')
    const failure = new EffectReentrantDisposeError(['effect', 'reentrant-owner'])

    expect(failure.code).toBe('EFFECT_REENTRANT_DISPOSE')
    expect(failure.labels).toEqual(['effect', 'reentrant-owner'])
    expect(failure.message).toContain('effect')
    expect(failure.message).toContain('reentrant-owner')
    expect(isJsonValue(failure.toJSON())).toBe(true)
    expect(failure).toBeInstanceOf(HarnessError)
    void owner
  })

  it('projects cleanup failures to stable, JSON-safe fields without free-form messages', () => {
    const failures: readonly EffectCleanupFailure[] = [
      { operationLabel: 'first', stage: 'revert', reason: new Error('secret detail') },
      { stage: 'revert', reason: 'string reason' },
      { operationLabel: 'third', stage: 'revert', reason: undefined },
    ]

    const projected = projectCleanupFailures(failures)

    expect(projected).toEqual([
      { operationLabel: 'first', stage: 'revert', reasonName: 'Error' },
      { stage: 'revert', reasonName: 'string' },
      { operationLabel: 'third', stage: 'revert', reasonName: 'undefined' },
    ])
    expect(isJsonValue(projected)).toBe(true)
    expect(JSON.stringify(projected)).not.toContain('secret detail')
  })

  it('describes arbitrary reasons by a stable name', () => {
    expect(describeReasonName(new TypeError('x'))).toBe('TypeError')
    expect(describeReasonName('text')).toBe('string')
    expect(describeReasonName(7)).toBe('number')
    expect(describeReasonName(null)).toBe('null')
    expect(describeReasonName({})).toBe('object')
  })

  it('keeps every diagnostic JSON-safe and free of recovery claims', async () => {
    const owner = new EffectOwner('diagnostics-safety')
    const lease = await owner.run('effect', async effect => {
      await effect.apply('op', () => 'value', () => {
        throw new Error('failed')
      })
    })

    const reason = await lease.dispose().then(
      () => undefined,
      (caught: unknown) => caught,
    )
    const json = (reason as EffectDisposalFailedError).toJSON()

    expect(isJsonValue(json)).toBe(true)
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
    expect(Object.keys(json).sort()).toEqual(['code', 'details', 'message', 'name'])
  })
})

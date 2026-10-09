import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { EffectDisposalFailedError, EffectOwner, EffectRollbackFailedError, EffectStartInterruptedError } from '../../src/index.js'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'

const startupCases = [
  { label: 'fulfilled setup', rejects: [false, false] },
  { label: 'Abort-rejected setup', rejects: [true, true] },
  { label: 'fulfilled older and Abort-rejected newer', rejects: [false, true] },
  { label: 'Abort-rejected older and fulfilled newer', rejects: [true, false] },
]

it('settles a newer interrupted startup before an older inverse waiting for its outcome', async () => {
  const owner = new EffectOwner('independent-startup-settlement')
  const accepted = createDeferred<void>(), finishSetup = createDeferred<void>()
  const olderEntered = createDeferred<void>(), rescueOlder = createDeferred<void>()
  const trace: string[] = []
  let newer!: Promise<unknown>, newerSettled = false
  await owner.run('older', effect => effect.apply('older-resource', () => undefined, async () => {
    trace.push('older:start')
    olderEntered.resolve()
    await Promise.race([newer, rescueOlder.promise])
    trace.push('older:end')
  }))
  newer = owner.run('newer', async effect => {
    await effect.apply('newer-resource', () => undefined, () => { trace.push('newer:reverted') })
    accepted.resolve()
    await finishSetup.promise
  }).catch((reason: unknown) => { newerSettled = true; return reason })
  await accepted.promise
  const disposal = owner.dispose()
  finishSetup.resolve()
  try {
    await olderEntered.promise
    await setImmediate()
    expect(newerSettled).toBe(true)
    expect(await newer).toMatchObject({ code: 'EFFECT_START_INTERRUPTED', attempted: 1, failed: 0 })
    await disposal
    expect(trace).toEqual(['newer:reverted', 'older:start', 'older:end'])
  } finally {
    rescueOlder.resolve()
    finishSetup.resolve()
    await disposal
    await newer
  }
})

it.each(startupCases.flatMap(startup => [false, true].map(cleanupFails => ({ ...startup, cleanupFails }))))(
  'hands $label to one serial Owner sweep (newer inverse fails: $cleanupFails)',
  async ({ rejects, cleanupFails }) => {
    const owner = new EffectOwner('startup-handoff')
    const labels = ['older', 'newer']
    const accepted = labels.map(() => createDeferred<void>())
    const finishSetup = labels.map(() => createDeferred<void>())
    const inverseStarted = labels.map(() => createDeferred<void>())
    const finishInverse = labels.map(() => createDeferred<void>())
    const firstInverse = createDeferred<number>()
    const setupReasons: unknown[] = []
    const inverseReason = new Error('newer inverse failed')
    const trace: string[] = [], attempts = [0, 0]
    const outcomes: Promise<unknown>[] = []
    for (const [index, label] of labels.entries()) {
      const startup = owner.run(label, async effect => {
        await effect.apply(`${label}-resource`, () => index, async value => {
          attempts[value] = attempts[value]! + 1
          trace.push(`${labels[value]}:start`)
          if (!firstInverse.settled()) firstInverse.resolve(value)
          inverseStarted[value]!.resolve()
          await finishInverse[value]!.promise
          trace.push(`${labels[value]}:end`)
          if (cleanupFails && value === 1) throw inverseReason
        })
        accepted[index]!.resolve()
        await finishSetup[index]!.promise
        if (rejects[index]) {
          expect(effect.signal.aborted).toBe(true)
          setupReasons[index] = effect.signal.reason
          throw effect.signal.reason
        }
        return label
      })
      outcomes.push(startup.catch((reason: unknown) => reason))
      await accepted[index]!.promise
    }
    const disposal = owner.dispose(), disposalOutcome = disposal.catch((reason: unknown) => reason)
    try {
      finishSetup[0]!.resolve()
      await drainMicrotasks(16)
      finishSetup[1]!.resolve()
      expect(await firstInverse.promise).toBe(1)
      expect(trace).toEqual(['newer:start'])
      expect(inverseStarted[0]!.settled()).toBe(false)
      finishInverse[1]!.resolve()
      await inverseStarted[0]!.promise
      expect(trace).toEqual(['newer:start', 'newer:end', 'older:start'])
      finishInverse[0]!.resolve()
      const [older, newer] = await Promise.all(outcomes)
      const ownerResult = await disposalOutcome
      if (rejects[0]) expect(older).toBe(setupReasons[0])
      else {
        expect(older).toBeInstanceOf(EffectStartInterruptedError)
        expect(older).toMatchObject({ effectLabel: 'older', attempted: 1, failed: 0 })
      }
      if (cleanupFails) {
        expect(newer).toBeInstanceOf(EffectRollbackFailedError)
        const failure = newer as EffectRollbackFailedError
        expect(failure.cleanupFailures.map(item => item.reason)).toEqual([inverseReason])
        if (rejects[1]) {
          expect(failure.setupReason).toBe(setupReasons[1])
          expect(failure.cause).toBe(setupReasons[1])
        } else {
          expect(failure.cause).toBeInstanceOf(EffectStartInterruptedError)
          expect(failure.cause).toMatchObject({ effectLabel: 'newer', attempted: 1, failed: 0 })
          expect(failure.setupReason).toBe(failure.cause)
        }
        expect(ownerResult).toBeInstanceOf(EffectDisposalFailedError)
        expect((ownerResult as EffectDisposalFailedError).cleanupFailures.map(item => item.reason)).toEqual([inverseReason])
      } else {
        expect(ownerResult).toBeUndefined()
        if (rejects[1]) expect(newer).toBe(setupReasons[1])
        else {
          expect(newer).toBeInstanceOf(EffectStartInterruptedError)
          expect(newer).toMatchObject({ effectLabel: 'newer', attempted: 1, failed: 0 })
        }
      }
      expect(trace).toEqual(['newer:start', 'newer:end', 'older:start', 'older:end'])
      expect(attempts).toEqual([1, 1])
      expect(owner.dispose()).toBe(disposal)
      expect(await owner.dispose().catch((reason: unknown) => reason)).toBe(ownerResult)
      expect(owner.status).toBe('disposed')
    } finally {
      finishSetup.forEach(gate => gate.resolve())
      finishInverse.forEach(gate => gate.resolve())
      await Promise.all(outcomes)
      await disposalOutcome
    }
  },
)

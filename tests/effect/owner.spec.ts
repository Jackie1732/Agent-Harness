import { describe, expect, it } from 'vitest'
import { EffectOwner } from '../../src/index.js'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'

describe('EffectOwner basic lifecycle', () => {
  it('releases a synchronous operation through its lease', async () => {
    const trace: string[] = []
    const owner = new EffectOwner('basic')

    const lease = await owner.run('resource', async effect => {
      return effect.apply('acquire', () => 'value', value => {
        trace.push(`revert:${value}`)
      })
    })

    expect(lease.value).toBe('value')
    expect(lease.label).toBe('resource')
    expect(trace).toEqual([])

    await lease.dispose()
    expect(trace).toEqual(['revert:value'])
  })

  it('releases an asynchronous operation through the owner', async () => {
    const trace: string[] = []
    const owner = new EffectOwner('async')

    await owner.run('resource', async effect => {
      await effect.apply('acquire', async () => {
        await drainMicrotasks()
        return 'value'
      }, async value => {
        await drainMicrotasks()
        trace.push(`revert:${value}`)
      })
    })

    expect(owner.status).toBe('accepting')
    await owner.dispose()
    expect(owner.status).toBe('disposed')
    expect(trace).toEqual(['revert:value'])
  })

  it('applies one effect inverses strictly in reverse acceptance order', async () => {
    const trace: string[] = []
    const owner = new EffectOwner('lifo')

    const lease = await owner.run('effect', async effect => {
      for (const name of ['first', 'second', 'third']) {
        await effect.apply(name, () => name, value => {
          trace.push(value)
        })
      }
    })

    await lease.dispose()
    expect(trace).toEqual(['third', 'second', 'first'])
  })

  it('waits for each asynchronous inverse before starting the next one', async () => {
    const trace: string[] = []
    const third = createDeferred<void>()
    const second = createDeferred<void>()
    const thirdStarted = createDeferred<void>()
    const secondStarted = createDeferred<void>()
    const owner = new EffectOwner('serial-lifo')

    const lease = await owner.run('effect', async effect => {
      await effect.apply('first', () => 'first', value => {
        trace.push(value)
      })
      await effect.apply('second', () => 'second', async value => {
        trace.push(value)
        secondStarted.resolve()
        await second.promise
      })
      await effect.apply('third', () => 'third', async value => {
        trace.push(value)
        thirdStarted.resolve()
        await third.promise
      })
    })

    const disposal = lease.dispose()
    await thirdStarted.promise
    expect(trace).toEqual(['third'])

    third.resolve()
    await secondStarted.promise
    expect(trace).toEqual(['third', 'second'])

    second.resolve()
    await disposal
    expect(trace).toEqual(['third', 'second', 'first'])
  })

  it('orders a global batch by acceptance order, not by effect creation order', async () => {
    const trace: string[] = []
    let accepted = 0
    const acceptedAt = new Map<string, number>()
    const owner = new EffectOwner('global')
    const slow = createDeferred<string>()
    const fast = createDeferred<string>()

    const earlier = owner.run('earlier', async effect => {
      await effect.apply('earlier-op', () => slow.promise, value => {
        trace.push(value)
      })
      acceptedAt.set('earlier-op', (accepted += 1))
    })
    const later = owner.run('later', async effect => {
      await effect.apply('later-op', () => fast.promise, value => {
        trace.push(value)
      })
      acceptedAt.set('later-op', (accepted += 1))
    })

    await drainMicrotasks()
    fast.resolve('fast-value')
    slow.resolve('slow-value')
    await Promise.all([earlier, later])

    const earlierAcceptedFirst = acceptedAt.get('earlier-op')! < acceptedAt.get('later-op')!
    // The two effects were created in a fixed order, but their inverses were accepted in
    // the opposite one; recovery follows the accepted order, so the effect that accepted
    // first is reverted last.
    const expected = earlierAcceptedFirst ? ['fast-value', 'slow-value'] : ['slow-value', 'fast-value']

    await owner.dispose()
    expect(trace).toEqual(expected)
  })

  it('returns a releasable lease for a setup without operations', async () => {
    const owner = new EffectOwner('empty')
    const lease = await owner.run('no-ops', () => 42)

    expect(lease.value).toBe(42)
    await lease.dispose()
    expect(owner.status).toBe('accepting')
    await owner.dispose()
    expect(owner.status).toBe('disposed')
  })

  it('accepts repeated labels for effects and operations', async () => {
    const trace: string[] = []
    const owner = new EffectOwner('labels')

    const first = await owner.run('same', async effect => {
      await effect.apply('same', () => 'a', value => {
        trace.push(value)
      })
    })
    const second = await owner.run('same', async effect => {
      await effect.apply('same', () => 'b', value => {
        trace.push(value)
      })
    })

    expect(first.label).toBe('same')
    expect(second.label).toBe('same')

    await Promise.all([first.dispose(), second.dispose()])
    expect(trace.sort()).toEqual(['a', 'b'])
  })

  it('keeps the setup result type on the lease value', async () => {
    const owner = new EffectOwner('typing')
    const lease = await owner.run('typed', () => ({ count: 3, name: 'resource' }))

    expect(lease.value.count).toBe(3)
    expect(lease.value.name).toBe('resource')
  })

  it('rejects an empty label before running setup', async () => {
    const owner = new EffectOwner('empty-label')
    let started = false

    await expect(owner.run('', () => {
      started = true
      return 1
    })).rejects.toThrow(TypeError)
    expect(started).toBe(false)

    await owner.run('outer', async effect => {
      await expect(effect.apply('', () => 1, () => {})).rejects.toThrow(TypeError)
    })
  })

  it('exposes one signal per effect, shared by every operation', async () => {
    const owner = new EffectOwner('signal')
    const signals: AbortSignal[] = []

    const lease = await owner.run('effect', async effect => {
      signals.push(effect.signal)
      await effect.apply('op', () => 1, () => {})
      signals.push(effect.signal)
      return effect.signal
    })

    expect(signals[0]).toBe(signals[1])
    expect(lease.value).toBe(signals[0])
    expect(lease.value.aborted).toBe(false)

    await lease.dispose()
    expect(lease.value.aborted).toBe(true)
  })

  it('keeps the settled run result unchanged when the lease is released later', async () => {
    const owner = new EffectOwner('stable-result')
    const lease = await owner.run('effect', () => 'value')

    await lease.dispose()
    expect(lease.value).toBe('value')
    expect(owner.status).toBe('accepting')
  })
})

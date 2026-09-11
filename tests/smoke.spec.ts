import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  EffectOwner,
  HARNESS_VERSION,
  createCapabilityKey,
  noopLogger,
  systemClock,
} from '../src/index.js'

describe('public source entry', () => {
  it('loads through NodeNext ESM resolution', () => {
    expect(HARNESS_VERSION).toBe('0.0.0')
    expect(Number.isFinite(systemClock.now())).toBe(true)
    expect(noopLogger.write('info', 'smoke')).toBeUndefined()
  })

  it('exports the Step 1 lifecycle kernel', async () => {
    const trace: string[] = []
    const owner = new EffectOwner('smoke')

    const lease = await owner.run('effect', async effect => {
      return await effect.apply('op', () => 'value', value => {
        trace.push(value)
      })
    })

    expect(lease.value).toBe('value')
    await lease.dispose()
    await owner.dispose()
    expect(trace).toEqual(['value'])
    expect(owner.status).toBe('disposed')
  })

  it('exports the Step 2 capability layer', async () => {
    const capability = createCapabilityKey<string>('smoke.capability')
    const registry = new CapabilityRegistry()
    const consumed: string[] = []

    registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'bound')
      },
    })
    const consumer = registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: context => {
        consumed.push(context.require(capability))
      },
    })

    await registry.whenQuiescent()

    expect(consumer.status).toBe('active')
    expect(consumed).toEqual(['bound'])
    await registry.dispose()
    expect(registry.snapshot().providers).toEqual([])
  })
})

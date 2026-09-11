import { describe, expect, it } from 'vitest'
import { EffectOwner, HARNESS_VERSION, noopLogger, systemClock } from '../src/index.js'

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
})

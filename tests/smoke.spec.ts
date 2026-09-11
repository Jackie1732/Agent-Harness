import { describe, expect, it } from 'vitest'
import { HARNESS_VERSION, noopLogger, systemClock } from '../src/index.js'

describe('public source entry', () => {
  it('loads through NodeNext ESM resolution', () => {
    expect(HARNESS_VERSION).toBe('0.0.0')
    expect(Number.isFinite(systemClock.now())).toBe(true)
    expect(noopLogger.write('info', 'smoke')).toBeUndefined()
  })
})

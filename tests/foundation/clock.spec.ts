import { describe, expect, it } from 'vitest'
import { systemClock } from '../../src/index.js'
import type { Clock } from '../../src/index.js'

describe('Clock', () => {
  it('accepts a deterministic replacement', () => {
    const clock: Clock = { now: () => 1_234 }

    expect(clock.now()).toBe(1_234)
  })

  it('provides finite epoch milliseconds in the system implementation', () => {
    expect(Number.isFinite(systemClock.now())).toBe(true)
  })
})

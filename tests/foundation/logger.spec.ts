import { describe, expect, it } from 'vitest'
import { noopLogger } from '../../src/index.js'

describe('noopLogger', () => {
  it('accepts every level and structured fields without producing a result', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      expect(noopLogger.write(level, 'message', { requestId: 'request-1' })).toBeUndefined()
    }
  })
})

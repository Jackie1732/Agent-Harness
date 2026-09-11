import { describe, expect, it } from 'vitest'
import { HarnessError, isJsonValue } from '../../src/index.js'

describe('HarnessError', () => {
  it('projects stable fields and an Error cause to JSON', () => {
    const details = { attempt: 2 }
    const error = new HarnessError('TEST_FAILURE', 'test failed', {
      cause: new Error('inner failure'),
      details,
    })
    details.attempt = 3

    expect(error.toJSON()).toEqual({
      name: 'HarnessError',
      code: 'TEST_FAILURE',
      message: 'test failed',
      details: { attempt: 2 },
      cause: { name: 'Error', message: 'inner failure' },
    })
    expect(isJsonValue(error.toJSON())).toBe(true)
  })

  it('rejects non-JSON diagnostic details at the runtime boundary', () => {
    expect(() => new HarnessError('INVALID_DETAILS', 'invalid', {
      details: { value: undefined } as unknown as Record<string, never>,
    })).toThrow('error details.value: undefined is not a JSON value')
  })
})

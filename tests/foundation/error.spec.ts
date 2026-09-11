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

  it('serializes nested error causes recursively', () => {
    const root = new Error('root cause')
    const middle = new Error('middle error', { cause: root })
    const error = new HarnessError('NESTED_ERROR', 'outer error', { cause: middle })

    const json = error.toJSON()
    expect(json.cause).toEqual({
      name: 'Error',
      message: 'middle error',
      cause: {
        name: 'Error',
        message: 'root cause',
      },
    })
  })

  it('handles undefined details and cause gracefully', () => {
    const error = new HarnessError('NO_CONTEXT', 'simple error')

    expect(error.details).toBeUndefined()
    expect(error.cause).toBeUndefined()

    const json = error.toJSON()
    expect(json).not.toHaveProperty('details')
    expect(json).not.toHaveProperty('cause')
  })

  it('serializes non-Error cause values safely', () => {
    const error1 = new HarnessError('STRING_CAUSE', 'message', { cause: 'string cause' })
    expect(error1.toJSON().cause).toBe('string cause')

    const error2 = new HarnessError('OBJECT_CAUSE', 'message', { cause: { code: 'ERR' } })
    expect(error2.toJSON().cause).toEqual({ code: 'ERR' })
  })

  it('terminates a circular Error cause chain', () => {
    const circular = new Error('circular')
    circular.cause = circular
    const error = new HarnessError('CIRCULAR_CAUSE', 'outer error', { cause: circular })

    expect(error.toJSON().cause).toEqual({
      name: 'Error',
      message: 'circular',
      cause: '[circular Error cause]',
    })
  })

  it('bounds deeply nested Error cause chains', () => {
    let cause: Error = new Error('root')
    for (let depth = 0; depth < 20; depth += 1) {
      cause = new Error(`level-${depth}`, { cause })
    }
    const error = new HarnessError('DEEP_CAUSE', 'outer error', { cause })

    expect(JSON.stringify(error.toJSON())).toContain('[Error cause depth limit reached]')
  })
})

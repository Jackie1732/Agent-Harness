import { describe, expect, it } from 'vitest'
import { assertJsonValue, isJsonValue } from '../../src/index.js'

describe('JSON values', () => {
  it('accepts nested values and repeated non-cyclic references', () => {
    const shared = { id: 1 }
    const value = {
      primitive: [null, true, 1, 'text'],
      repeated: [shared, shared],
    }

    expect(isJsonValue(value)).toBe(true)
    expect(() => assertJsonValue(value)).not.toThrow()
  })

  it.each([
    ['undefined', undefined],
    ['bigint', 1n],
    ['function', () => undefined],
    ['symbol', Symbol('value')],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['Date', new Date(0)],
  ])('rejects %s', (_name, value) => {
    expect(isJsonValue(value)).toBe(false)
    expect(() => assertJsonValue(value, 'payload')).toThrow(/^payload/)
  })

  it('rejects cycles and reports their path', () => {
    const value: Record<string, unknown> = {}
    value.self = value

    expect(() => assertJsonValue(value, 'payload')).toThrow(
      'payload.self: circular reference',
    )
  })

  it('rejects sparse arrays and ignored extra array properties', () => {
    const sparse = Array.from({ length: 2 })
    sparse[0] = 'first'
    const extended: unknown[] & { label?: string } = []
    extended.label = 'ignored by JSON.stringify'

    expect(isJsonValue(sparse)).toBe(false)
    expect(isJsonValue(extended)).toBe(false)
  })

  it('rejects accessors without invoking them', () => {
    let reads = 0
    const objectValue = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'value'
      },
    })
    const arrayValue: unknown[] = []
    Object.defineProperty(arrayValue, '0', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'value'
      },
    })
    arrayValue.length = 1

    expect(isJsonValue(objectValue)).toBe(false)
    expect(isJsonValue(arrayValue)).toBe(false)
    expect(reads).toBe(0)
  })
})

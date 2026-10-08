import { describe, expect, it } from 'vitest'
import { applyConfigTreeOperations, decodeConfigOperations } from '../src/operator/config-tree.js'

describe('operator typed tree candidates', () => {
  it('replaces values and inserts array and escaped object fields without changing the source', () => {
    const source = { items: [1, 2], 'a/b': { '~field': null } }
    const result = applyConfigTreeOperations(source, decodeConfigOperations([
      { op: 'set', pointer: '/a~1b/~0field', value: false }, { op: 'insert', pointer: '/items/1', value: { key: 'value' } },
      { op: 'remove', pointer: '/items/0' }, { op: 'insert', pointer: '/items/-', value: 3 },
      { op: 'insert', pointer: '/__proto__', value: { safe: true } },
    ]))
    expect(result).toEqual({ items: [{ key: 'value' }, 2, 3], 'a/b': { '~field': false }, ['__proto__']: { safe: true } })
    expect(source).toEqual({ items: [1, 2], 'a/b': { '~field': null } })
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  })
  it.each(['/items/01', '/items/-1', '/items/2', '/missing', '/a~2b'])('rejects absent values and noncanonical indices: %s', pointer => {
    expect(() => applyConfigTreeOperations({ items: [1, 2] }, [{ op: 'set', pointer, value: 0 }])).toThrow()
  })
  it('allows only set at the root and requires explicit values', () => {
    expect(applyConfigTreeOperations({ a: 1 }, [{ op: 'set', pointer: '', value: null }])).toBeNull()
    expect(() => applyConfigTreeOperations({}, [{ op: 'remove', pointer: '' }])).toThrow()
    for (const input of [[], [{ op: 'set', pointer: '/a' }], [{ op: 'remove', pointer: '/a', value: null }], [{ op: 'execute', pointer: '' }]]) expect(() => decodeConfigOperations(input)).toThrow()
  })
})

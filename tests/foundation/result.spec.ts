import { describe, expect, it } from 'vitest'
import { err, isErr, isOk, ok } from '../../src/index.js'
import type { Result } from '../../src/index.js'

function render(result: Result<number, string>): string {
  return result.ok ? `value:${result.value}` : `error:${result.error}`
}

describe('Result', () => {
  it('constructs and narrows successful outcomes', () => {
    const result: Result<number, string> = ok(42)

    expect(isOk(result)).toBe(true)
    expect(isErr(result)).toBe(false)
    expect(render(result)).toBe('value:42')
  })

  it('constructs and narrows expected failures', () => {
    const result: Result<number, string> = err('missing')

    expect(isErr(result)).toBe(true)
    expect(isOk(result)).toBe(false)
    expect(render(result)).toBe('error:missing')
  })
})

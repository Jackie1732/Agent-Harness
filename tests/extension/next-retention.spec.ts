import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import { CapabilityRegistry, createMiddlewareName } from '../../src/index.js'
import type { MiddlewareNext } from '../../src/index.js'

it.each([false, true])('retires a saved next request after its handler settles (called=%s)', async called => {
  class Request { value = 'request' }
  async function invoke(): Promise<MiddlewareNext<Request, string>> {
    const registry = new CapabilityRegistry()
    const name = createMiddlewareName<Request, string>('saved-next-retirement')
    let saved: MiddlewareNext<Request, string> | undefined
    registry.scope.intercept(name, 'save next', (request, next) => {
      saved = next
      return called ? next(request) : 'outer'
    })
    try {
      await registry.scope.invoke(name, new Request(), request => request.value)
    } finally { await registry.dispose() }
    if (saved === undefined) throw new Error('handler did not save next')
    return saved
  }
  expect(queryObjects(Request, { format: 'count' })).toBe(0)
  const next = await invoke()
  await setImmediate()
  expect(queryObjects(Request, { format: 'count' })).toBe(0)
  await expect(next()).rejects.toMatchObject({
    code: called ? 'MIDDLEWARE_NEXT_REPEATED' : 'MIDDLEWARE_NEXT_INACTIVE',
    middlewareName: 'saved-next-retirement', handlerLabel: 'save next',
  })
})

import { describe, expect, it } from 'vitest'
import { CapabilityRegistry, createMiddlewareName } from '../../src/index.js'
import type { MiddlewareNext } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'

describe('middleware next lifetime', () => {
  it.each(['return', 'throw'] as const)('closes a synchronous handler window on %s before queued work', async outcome => {
    const registry = new CapabilityRegistry()
    const name = createMiddlewareName<void, string>(`sync next window ${outcome}`)
    const failure = { source: 'handler failure' }
    let queued: Promise<unknown> | undefined
    let terminalCalls = 0
    registry.scope.intercept(name, 'queue next', (_request, next) => {
      queueMicrotask(() => { queued = next().catch((reason: unknown) => reason) })
      if (outcome === 'throw') throw failure
      return 'outer'
    })
    try {
      const invocation = registry.scope.invoke(name, undefined, () => {
        terminalCalls += 1
        return 'terminal'
      })
      if (outcome === 'throw') await expect(invocation).rejects.toBe(failure)
      else await expect(invocation).resolves.toBe('outer')
      await expect(queued).resolves.toMatchObject({ code: 'MIDDLEWARE_NEXT_INACTIVE' })
      expect(terminalCalls).toBe(0)
    } finally {
      await registry.dispose()
    }
  })

  it.each(['fulfilled', 'rejected'] as const)('closes a PromiseLike handler after %s settlement', async outcome => {
    const registry = new CapabilityRegistry()
    const name = createMiddlewareName<void, string>(`promise-like next ${outcome}`)
    const result = createDeferred<string>()
    const failure = { source: 'promise-like failure' }
    let saved: MiddlewareNext<void, string> | undefined
    let terminalCalls = 0
    registry.scope.intercept(name, 'promise-like handler', (_request, next) => {
      saved = next
      // oxlint-disable-next-line unicorn/no-thenable -- Awaitable accepts non-native PromiseLike results.
      return { then: result.promise.then.bind(result.promise) }
    })
    const invocation = registry.scope.invoke(name, undefined, () => {
      terminalCalls += 1
      return 'terminal'
    })
    try {
      if (outcome === 'rejected') {
        result.reject(failure)
        await expect(invocation).rejects.toBe(failure)
      } else {
        result.resolve('outer')
        await expect(invocation).resolves.toBe('outer')
      }
      if (saved === undefined) throw new Error('handler did not expose next')
      await expect(saved()).rejects.toMatchObject({ code: 'MIDDLEWARE_NEXT_INACTIVE' })
      expect(terminalCalls).toBe(0)
    } finally {
      result.resolve('rescued')
      await invocation.catch(() => undefined)
      await registry.dispose()
    }
  })
})

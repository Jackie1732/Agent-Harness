import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  createEventName,
  createMiddlewareName,
} from '../../src/index.js'
import type { MiddlewareNext } from '../../src/index.js'
import { createDeferred, settle } from '../helpers/deferred.js'

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('middleware continuation execution context', () => {
  it.each(['origin', 'current frame', 'upstream frame'] as const)(
    'retains its original %s token when next runs from another call chain',
    async target => {
      const registry = new CapabilityRegistry()
      const origin = registry.scope.derive('origin')
      const upstream = registry.scope.derive('upstream')
      const current = registry.scope.derive('current')
      const name = createMiddlewareName<void, string>(`external next ${target}`)
      const handler = createDeferred<string>()
      const rescue = createDeferred<string>()
      let saved: MiddlewareNext<void, string> | undefined
      let outcome: Awaited<ReturnType<typeof settle>> | undefined
      let wait: Promise<string> | undefined
      upstream.intercept(name, 'upstream', (_request, next) => next())
      current.intercept(name, 'external continuation', (_request, next) => {
        saved = next
        return handler.promise
      })
      const invocation = origin.invoke(name, undefined, async () => {
        const scope = target === 'origin' ? origin : target === 'current frame' ? current : upstream
        wait = settle(scope.whenQuiescent()).then(result => {
          outcome = result
          return 'observed'
        })
        return await Promise.race([wait, rescue.promise])
      })
      let continuation: Promise<string> | undefined
      try {
        if (saved === undefined) throw new Error('handler did not expose next')
        continuation = saved()
        void continuation.then(handler.resolve, handler.reject)
        await turn()
        expect(outcome).toMatchObject({
          status: 'rejected',
          reason: { code: 'SCOPE_REENTRANT_WAIT' },
        })
        await expect(invocation).resolves.toBe('observed')
      } finally {
        rescue.resolve('rescued')
        await Promise.allSettled([continuation, invocation, wait])
        await registry.dispose()
      }
    },
  )

  it('merges the external caller tokens while permitting a sibling wait', async () => {
    const registry = new CapabilityRegistry()
    const origin = registry.scope.derive('origin')
    const current = registry.scope.derive('current')
    const caller = registry.scope.derive('external caller')
    const sibling = registry.scope.derive('sibling')
    const name = createMiddlewareName<void, string>('external caller context')
    const event = createEventName<void>('external caller trigger')
    const handler = createDeferred<string>()
    const rescue = createDeferred<string>()
    let saved: MiddlewareNext<void, string> | undefined
    let outcome: Awaited<ReturnType<typeof settle>> | undefined
    let wait: Promise<string> | undefined
    current.intercept(name, 'save active next', (_request, next) => {
      saved = next
      return handler.promise
    })
    const invocation = origin.invoke(name, undefined, async () => {
      await expect(sibling.whenQuiescent()).resolves.toMatchObject({ subtreeInFlight: 0 })
      wait = settle(caller.whenQuiescent()).then(result => {
        outcome = result
        return 'observed'
      })
      return await Promise.race([wait, rescue.promise])
    })
    caller.on(event, 'resume saved next', async () => {
      if (saved === undefined) throw new Error('handler did not expose next')
      const continuation = saved()
      void continuation.then(handler.resolve, handler.reject)
      await continuation
    })
    const emission = caller.emit(event, undefined)
    try {
      await turn()
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { code: 'SCOPE_REENTRANT_WAIT' },
      })
      await emission
      await invocation
    } finally {
      rescue.resolve('rescued')
      await Promise.allSettled([emission, invocation, wait])
      await registry.dispose()
    }
  })

  it('ignores its retired handler frame while its delegated origin is still active', async () => {
    const registry = new CapabilityRegistry()
    const origin = registry.scope.derive('origin')
    const current = registry.scope.derive('current')
    const name = createMiddlewareName<void, string>('retired handler context')
    const handler = createDeferred<string>()
    const continueTerminal = createDeferred<void>()
    const rescue = createDeferred<string>()
    let saved: MiddlewareNext<void, string> | undefined
    let outcome: Awaited<ReturnType<typeof settle>> | undefined
    let wait: Promise<string> | undefined
    current.intercept(name, 'save active next', (_request, next) => {
      saved = next
      return handler.promise
    })
    const invocation = origin.invoke(name, undefined, async () => {
      await continueTerminal.promise
      wait = settle(current.whenQuiescent()).then(result => {
        outcome = result
        return 'terminal'
      })
      return await Promise.race([wait, rescue.promise])
    })
    let continuation: Promise<string> | undefined
    try {
      if (saved === undefined) throw new Error('handler did not expose next')
      continuation = saved()
      handler.resolve('outer')
      await expect(invocation).resolves.toBe('outer')
      expect(origin.snapshot().subtreeInFlight).toBe(1)
      continueTerminal.resolve(undefined)
      await turn()
      expect(outcome).toMatchObject({ status: 'fulfilled', value: { subtreeInFlight: 0 } })
      await expect(continuation).resolves.toBe('terminal')
    } finally {
      continueTerminal.resolve(undefined)
      rescue.resolve('rescued')
      handler.resolve('rescued')
      await Promise.allSettled([continuation, invocation, wait])
      await registry.dispose()
    }
  })

  it('settles a detached failed continuation without changing the outer result', async () => {
    const registry = new CapabilityRegistry()
    const origin = registry.scope.derive('detached origin')
    const name = createMiddlewareName<void, string>('detached failure')
    const terminal = createDeferred<string>()
    const failure = { source: 'terminal failure' }
    let continuation: Promise<string> | undefined
    registry.scope.intercept(name, 'detached next', (_request, next) => {
      continuation = next()
      return 'outer'
    })
    const invocation = origin.invoke(name, undefined, () => terminal.promise)
    try {
      await expect(invocation).resolves.toBe('outer')
      expect(origin.snapshot().subtreeInFlight).toBe(1)
      const barrier = origin.whenQuiescent()
      terminal.reject(failure)
      await expect(continuation).rejects.toBe(failure)
      await expect(barrier).resolves.toMatchObject({ subtreeInFlight: 0 })
    } finally {
      terminal.resolve('rescued')
      await Promise.allSettled([invocation, continuation])
      await registry.dispose()
    }
  })
})

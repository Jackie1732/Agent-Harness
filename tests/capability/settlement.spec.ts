import { describe, expect, it } from 'vitest'
import { CapabilityRegistry, createCapabilityKey, createEventName, createMiddlewareName } from '../../src/index.js'
import type { ComponentHandle } from '../../src/index.js'
import { createDeferred, drainMicrotasks, settle } from '../helpers/deferred.js'

describe('Registry barrier settlement after public Scope calls', () => {
  it.each(['event', 'middleware', 'event and middleware'] as const)(
    'finishes every Component release when disposal immediately follows root %s completion',
    async operation => {
      const registry = new CapabilityRegistry()
      const input = createCapabilityKey<string>(`settlement.${operation}`)
      const provider = registry.mount({
        label: 'provider', requires: [], provides: [input], setup: context => context.provide(input, 'value'),
      })
      const seen: string[] = []
      const consumer = registry.mount({
        label: 'consumer', requires: [input], provides: [], setup: context => { seen.push(context.require(input)) },
      })
      try {
        await registry.whenQuiescent()
        expect(consumer.status).toBe('active')
        const event = createEventName<number>(`settlement.event.${operation}`)
        const middleware = createMiddlewareName<string, string>(`settlement.middleware.${operation}`)
        registry.scope.on(event, 'listener', () => {})
        registry.scope.intercept(middleware, 'handler', async (request, next) => `${request}:${await next()}`)
        if (operation !== 'middleware') await registry.scope.emit(event, 3)
        if (operation !== 'event') {
          expect(await registry.scope.invoke(middleware, 'outer', () => 'terminal')).toBe('outer:terminal')
        }
        await registry.dispose()
        expect(registry.status).toBe('disposed')
        expect(provider.status).toBe('disposed')
        expect(consumer.status).toBe('disposed')
        expect(registry.snapshot().providers).toEqual([])
        expect(seen).toEqual(['value'])
      } finally {
        await settle(registry.dispose())
        await settle(consumer.dispose())
        await settle(provider.dispose())
      }
    },
  )

  it('settles Provider retirement and its same-key replacement before returning the next barrier', async () => {
    const registry = new CapabilityRegistry()
    const input = createCapabilityKey<string>('settlement.replacement')
    const event = createEventName<void>('settlement.execute')
    const entered = createDeferred<void>()
    const rescue = createDeferred<void>()
    const outcomes: string[] = []
    const cleaned: string[] = []
    const mountProvider = (value: string): ComponentHandle => registry.mount({
      label: value, requires: [], provides: [input],
      setup: async context => {
        const resource = await context.apply('provider resource', () => value, owned => { cleaned.push(owned) })
        context.provide(input, resource)
      },
    })
    const first = mountProvider('A')
    const consumer = registry.mount({
      label: 'consumer', requires: [input], provides: [],
      setup: async context => {
        const value = context.require(input)
        const signal = context.signal
        await context.apply('consumer resource', () => value, () => {})
        context.scope.on(event, 'execute', async () => {
          if (value === 'A') {
            const aborted = new Promise<void>(resolve => {
              if (signal.aborted) resolve()
              else signal.addEventListener('abort', () => resolve(), { once: true })
            })
            entered.resolve(undefined)
            await Promise.race([aborted, rescue.promise])
            outcomes.push('cancelled:A')
          } else {
            outcomes.push(`completed:${value}`)
          }
        })
      },
    })
    let emission: Promise<unknown> | undefined
    let replacement: ComponentHandle | undefined
    try {
      await registry.whenQuiescent()
      emission = settle(registry.scope.emit(event, undefined))
      await drainMicrotasks(100)
      expect(entered.settled()).toBe(true)
      await first.dispose()
      await emission
      expect(outcomes).toEqual(['cancelled:A'])
      expect(cleaned).toEqual(['A'])
      replacement = mountProvider('B')
      const snapshot = await registry.whenQuiescent()
      expect(replacement.status).toBe('active')
      expect(consumer.status).toBe('active')
      expect(snapshot.components.find(component => component.id === replacement?.id)?.status).toBe('active')
      await registry.scope.emit(event, undefined)
      expect(outcomes).toEqual(['cancelled:A', 'completed:B'])
    } finally {
      rescue.resolve(undefined)
      await emission
      await settle(registry.dispose())
      await settle(consumer.dispose())
      await settle(first.dispose())
      if (replacement !== undefined) await settle(replacement.dispose())
    }
  })
})

import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { CapabilityRegistry, createCapabilityKey, createEventName } from '../../src/index.js'
import type { Scope } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'

describe('Component cancellation and Scope settlement', () => {
  it.each(['component', 'registry', 'dependency'] as const)(
    'notifies the captured activation signal before waiting for a frame during %s release',
    async mode => {
      const registry = new CapabilityRegistry()
      const dependency = createCapabilityKey<string>(`signal.${mode}.dependency`)
      const event = createEventName<void>(`signal.${mode}.event`)
      const started = createDeferred<void>()
      const cancelled = createDeferred<void>()
      const finish = createDeferred<void>()
      const trace: string[] = []
      let signal!: AbortSignal
      let scope!: Scope
      let live = false
      const provider = registry.mount({
        label: 'dependency', requires: [], provides: [dependency],
        setup: async context => {
          await context.apply('dependency resource', () => 'bound', () => { trace.push('dependency:cleanup') })
          context.provide(dependency, 'bound')
        },
      })
      const component = registry.mount({
        label: 'consumer', requires: [dependency], provides: [],
        setup: async context => {
          signal = context.signal
          expect(context.signal).toBe(signal)
          scope = context.scope
          signal.addEventListener('abort', () => cancelled.resolve(undefined), { once: true })
          await context.apply('consumer resource', () => { live = true }, () => {
            trace.push('consumer:cleanup'); live = false
          })
          scope.on(event, 'cooperative frame', async () => {
            started.resolve(undefined)
            await cancelled.promise
            trace.push(`frame:cancelled:${live}`)
            await finish.promise
            trace.push(`frame:finished:${live}`)
          })
        },
      })
      await registry.whenQuiescent()
      const emission = registry.scope.emit(event, undefined)
      await started.promise
      let release: Promise<void> | undefined
      try {
        release = mode === 'component' ? component.dispose()
          : mode === 'registry' ? registry.dispose() : provider.dispose()
        await setImmediate()
        expect(scope.status).toBe('disposing')
        expect(signal.aborted).toBe(true)
        expect(trace).toEqual(['frame:cancelled:true'])
        expect(live).toBe(true)
        expect(registry.snapshot().providers).toHaveLength(1)

        finish.resolve(undefined)
        await emission
        await release
        expect(trace.slice(0, 3)).toEqual(['frame:cancelled:true', 'frame:finished:true', 'consumer:cleanup'])
        expect(live).toBe(false)
        expect(signal.aborted).toBe(true)
        if (mode !== 'component') expect(trace[3]).toBe('dependency:cleanup')
      } finally {
        cancelled.resolve(undefined)
        finish.resolve(undefined)
        await Promise.allSettled([emission, ...(release === undefined ? [] : [release])])
        await registry.dispose()
      }
    },
  )

  it('cancels a captured activation signal when its Scope is explicitly closed without releasing resources early', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('signal.scope.closed')
    const started = createDeferred<void>()
    const cancelled = createDeferred<void>()
    const finish = createDeferred<void>()
    let signal!: AbortSignal
    let scope!: Scope
    let releases = 0
    const component = registry.mount({
      label: 'scoped consumer', requires: [], provides: [],
      setup: async context => {
        signal = context.signal
        scope = context.scope
        signal.addEventListener('abort', () => cancelled.resolve(undefined), { once: true })
        await context.apply('resource', () => undefined, () => { releases++ })
        scope.on(event, 'frame', async () => {
          started.resolve(undefined)
          await cancelled.promise
          await finish.promise
        })
      },
    })
    await registry.whenQuiescent()
    const emission = registry.scope.emit(event, undefined)
    await started.promise
    const closing = scope.dispose()
    try {
      await setImmediate()
      expect(signal.aborted).toBe(true)
      expect(scope.status).toBe('disposing')
      expect(releases).toBe(0)
      finish.resolve(undefined)
      await emission
      await closing
      expect(scope.status).toBe('disposed')
      expect(component.status).toBe('active')
      expect(releases).toBe(0)
      await component.dispose()
      expect(releases).toBe(1)
    } finally {
      cancelled.resolve(undefined)
      finish.resolve(undefined)
      await Promise.allSettled([emission, closing])
      await registry.dispose()
    }
  })

  it('allocates a fresh stable signal for a replacement activation and leaves the retired signal cancelled', async () => {
    const registry = new CapabilityRegistry()
    const dependency = createCapabilityKey<string>('signal.replacement.dependency')
    const signals: AbortSignal[] = []
    const scopes: Scope[] = []
    let releases = 0
    const first = registry.mount({
      label: 'first provider', requires: [], provides: [dependency],
      setup: context => { context.provide(dependency, 'first') },
    })
    const consumer = registry.mount({
      label: 'consumer', requires: [dependency], provides: [],
      setup: async context => {
        const signal = context.signal
        expect(context.signal).toBe(signal)
        signals.push(signal)
        scopes.push(context.scope)
        await context.apply('resource', () => context.require(dependency), () => { releases++ })
      },
    })
    try {
      await registry.whenQuiescent()
      expect(signals).toHaveLength(1)
      expect(signals[0]!.aborted).toBe(false)
      await first.dispose()
      expect(consumer.status).toBe('unsatisfied')
      expect(signals[0]!.aborted).toBe(true)
      expect(releases).toBe(1)

      registry.mount({
        label: 'replacement provider', requires: [], provides: [dependency],
        setup: context => { context.provide(dependency, 'replacement') },
      })
      await registry.whenQuiescent()
      expect(consumer.status).toBe('active')
      expect(signals).toHaveLength(2)
      expect(signals[1]).not.toBe(signals[0])
      expect(signals[1]!.aborted).toBe(false)
      expect(signals[0]!.aborted).toBe(true)
      await scopes[0]!.dispose()
      expect(signals[1]!.aborted).toBe(false)
      await consumer.dispose()
      expect(signals[1]!.aborted).toBe(true)
      expect(releases).toBe(2)
    } finally { await registry.dispose() }
  })
})

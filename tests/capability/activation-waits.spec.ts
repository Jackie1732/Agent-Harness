import { describe, expect, it } from 'vitest'
import { CapabilityRegistry, createCapabilityKey, createEventName } from '../../src/index.js'
import type { ComponentHandle } from '../../src/index.js'
import { createDeferred, drainMicrotasks, settle } from '../helpers/deferred.js'

type WaitMethod = 'barrier' | 'component release' | 'registry release'
type WaitOutcome = Awaited<ReturnType<typeof settle<void>>>

function waitFor(method: WaitMethod, registry: CapabilityRegistry, handle: ComponentHandle): Promise<void> {
  switch (method) {
    case 'barrier': return registry.whenQuiescent().then(() => undefined)
    case 'component release': return handle.dispose()
    case 'registry release': return registry.dispose()
  }
}

describe('activation cleanup waits', () => {
  it.each(['barrier', 'component release', 'registry release'] as const)(
    'rejects %s from missing-binding rollback and finishes cleanup',
    async method => {
      const registry = new CapabilityRegistry()
      const offered = createCapabilityKey<string>(`missing.${method}`)
      const cleanupStarted = createDeferred<void>()
      const rescue = createDeferred<void>()
      let outcome: WaitOutcome | undefined
      let cleanups = 0
      let handle: ComponentHandle
      handle = registry.mount({
        label: 'missing binding', requires: [], provides: [offered],
        setup: async context => {
          await context.apply('resource', () => undefined, async () => {
            cleanups += 1
            const observed = settle(waitFor(method, registry, handle)).then(result => { outcome = result })
            cleanupStarted.resolve(undefined)
            await Promise.race([observed, rescue.promise])
          })
        },
      })
      const activation = settle(registry.whenQuiescent())
      try {
        await cleanupStarted.promise
        await drainMicrotasks(100)
        expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'REGISTRY_REENTRANT_WAIT' } })
      } finally {
        rescue.resolve(undefined)
        await activation
        await settle(registry.dispose())
      }
      expect(cleanups).toBe(1)
      expect(registry.snapshot().providers).toEqual([])
    },
  )

  it.each(['barrier', 'component release', 'registry release'] as const)(
    'rejects %s from Scope publication rollback and publishes neither contributions nor bindings',
    async method => {
      const registry = new CapabilityRegistry()
      const offered = createCapabilityKey<string>(`publication.${method}`)
      const stagedEvent = createEventName<void>(`publication.${method}`)
      const publishedEvent = createEventName<void>(`publication.${method}`)
      const setupReady = createDeferred<void>()
      const finishSetup = createDeferred<void>()
      const cleanupStarted = createDeferred<void>()
      const rescue = createDeferred<void>()
      let outcome: WaitOutcome | undefined
      let calls = 0
      let cleanups = 0
      let handle: ComponentHandle
      handle = registry.mount({
        label: 'publication conflict', requires: [], provides: [offered],
        setup: async context => {
          await context.apply('resource', () => undefined, async () => {
            cleanups += 1
            const observed = settle(waitFor(method, registry, handle)).then(result => { outcome = result })
            cleanupStarted.resolve(undefined)
            await Promise.race([observed, rescue.promise])
          })
          context.scope.on(stagedEvent, 'staged listener', () => { calls += 1 })
          context.provide(offered, 'value')
          setupReady.resolve(undefined)
          await finishSetup.promise
        },
      })
      const activation = settle(registry.whenQuiescent())
      try {
        await setupReady.promise
        registry.scope.on(publishedEvent, 'published listener', () => {})
        finishSetup.resolve(undefined)
        await cleanupStarted.promise
        await drainMicrotasks(100)
        expect(registry.snapshot().providers).toEqual([])
        expect(registry.scope.snapshot().scopes.flatMap(scope => scope.registrations)
          .some(registration => registration.label === 'staged listener')).toBe(false)
        expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'REGISTRY_REENTRANT_WAIT' } })
      } finally {
        finishSetup.resolve(undefined)
        rescue.resolve(undefined)
        await activation
        await settle(registry.dispose())
      }
      expect(cleanups).toBe(1)
      expect(calls).toBe(0)
      expect(registry.snapshot().providers).toEqual([])
    },
  )

  it.each(['barrier', 'component release', 'registry release'] as const)(
    'rejects %s from cleanup started by an externally interrupted activation Owner',
    async method => {
      const registry = new CapabilityRegistry()
      const input = createCapabilityKey<string>(`interrupted.${method}`)
      const provider = registry.mount({
        label: 'provider', requires: [], provides: [input],
        setup: context => context.provide(input, 'value'),
      })
      await registry.whenQuiescent()
      const setupReady = createDeferred<void>()
      const setupRescue = createDeferred<void>()
      const cleanupStarted = createDeferred<void>()
      const cleanupRescue = createDeferred<void>()
      let outcome: WaitOutcome | undefined
      let cleanups = 0
      let sawAbort = false
      let consumer: ComponentHandle
      consumer = registry.mount({
        label: 'interrupted consumer', requires: [input], provides: [],
        setup: async context => {
          await context.apply('resource', () => undefined, async () => {
            cleanups += 1
            const observed = settle(waitFor(method, registry, consumer)).then(result => { outcome = result })
            cleanupStarted.resolve(undefined)
            await Promise.race([observed, cleanupRescue.promise])
          })
          const aborted = new Promise<void>(resolve => {
            context.signal.addEventListener('abort', () => { sawAbort = true; resolve() }, { once: true })
          })
          setupReady.resolve(undefined)
          await Promise.race([aborted, setupRescue.promise])
        },
      })
      let release: Promise<unknown> | undefined
      try {
        await setupReady.promise
        release = settle(provider.dispose())
        await cleanupStarted.promise
        await drainMicrotasks(100)
        expect(sawAbort).toBe(true)
        expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'REGISTRY_REENTRANT_WAIT' } })
      } finally {
        setupRescue.resolve(undefined)
        cleanupRescue.resolve(undefined)
        await release
        await settle(registry.dispose())
      }
      expect(cleanups).toBe(1)
      expect(registry.snapshot().providers).toEqual([])
    },
  )
})

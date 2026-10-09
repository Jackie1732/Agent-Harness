import { describe, expect, it } from 'vitest'
import { CapabilityRegistry, createCapabilityKey } from '../../src/index.js'
import { createDeferred, drainMicrotasks, settle } from '../helpers/deferred.js'

describe('Component retry task admission', () => {
  it('joins an ongoing retry and rejects the cached task after activation succeeds', async () => {
    const registry = new CapabilityRegistry()
    const retryReady = createDeferred<void>()
    const finishRetry = createDeferred<void>()
    const blockerReady = createDeferred<void>()
    const finishBlocker = createDeferred<void>()
    let attempts = 0
    const component = registry.mount({
      label: 'retry target', requires: [], provides: [],
      setup: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('first activation fails')
        retryReady.resolve(undefined)
        await finishRetry.promise
      },
    })
    await registry.whenQuiescent()
    const first = component.retry()
    expect(component.retry()).toBe(first)
    registry.mount({
      label: 'unrelated activation', requires: [], provides: [],
      setup: async () => { blockerReady.resolve(undefined); await finishBlocker.promise },
    })
    try {
      await retryReady.promise
      expect(component.status).toBe('activating')
      expect(component.retry()).toBe(first)
      finishRetry.resolve(undefined)
      await blockerReady.promise
      expect(component.status).toBe('active')
      let outcome: Awaited<ReturnType<typeof settle<void>>> | undefined
      void settle(component.retry()).then(result => { outcome = result })
      await drainMicrotasks(100)
      expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'COMPONENT_INACTIVE', state: 'active' } })
    } finally {
      finishRetry.resolve(undefined)
      finishBlocker.resolve(undefined)
      await first
      await registry.dispose()
    }
    expect(attempts).toBe(2)
  })

  it('rejects a cached retry when its Component has started deactivating', async () => {
    const registry = new CapabilityRegistry()
    const input = createCapabilityKey<string>('retry.deactivating')
    const provider = registry.mount({
      label: 'provider', requires: [], provides: [input], setup: context => context.provide(input, 'value'),
    })
    const retryReady = createDeferred<void>()
    const finishRetry = createDeferred<void>()
    const blockerReady = createDeferred<void>()
    const finishBlocker = createDeferred<void>()
    const cleanupReady = createDeferred<void>()
    const finishCleanup = createDeferred<void>()
    let attempts = 0
    const component = registry.mount({
      label: 'consumer', requires: [input], provides: [],
      setup: async context => {
        attempts += 1
        if (attempts === 1) throw new Error('first activation fails')
        await context.apply('resource', () => undefined, async () => { cleanupReady.resolve(undefined); await finishCleanup.promise })
        retryReady.resolve(undefined)
        await finishRetry.promise
      },
    })
    await registry.whenQuiescent()
    const retry = component.retry()
    registry.mount({
      label: 'unrelated activation', requires: [], provides: [],
      setup: async () => { blockerReady.resolve(undefined); await finishBlocker.promise },
    })
    let release: Promise<void> | undefined
    try {
      await retryReady.promise
      finishRetry.resolve(undefined)
      await blockerReady.promise
      release = provider.dispose()
      finishBlocker.resolve(undefined)
      await cleanupReady.promise
      expect(component.status).toBe('deactivating')
      let outcome: Awaited<ReturnType<typeof settle<void>>> | undefined
      void settle(component.retry()).then(result => { outcome = result })
      await drainMicrotasks(100)
      expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'COMPONENT_INACTIVE', state: 'deactivating' } })
    } finally {
      finishRetry.resolve(undefined)
      finishBlocker.resolve(undefined)
      finishCleanup.resolve(undefined)
      await release
      await retry
      await registry.dispose()
    }
    expect(attempts).toBe(2)
  })

  it('rejects a cached retry after a new activation rollback leaves cleanup incomplete', async () => {
    const registry = new CapabilityRegistry()
    const blockerReady = createDeferred<void>()
    const finishBlocker = createDeferred<void>()
    let attempts = 0
    let failure: unknown
    const component = registry.mount({
      label: 'unsafe retry', requires: [], provides: [],
      setup: async context => {
        attempts += 1
        if (attempts === 1) throw new Error('first activation fails safely')
        await context.apply('resource', () => undefined, () => { throw new Error('rollback failed') })
        throw new Error('second activation failed')
      },
    })
    await registry.whenQuiescent()
    const retry = component.retry()
    registry.mount({
      label: 'unrelated activation', requires: [], provides: [],
      setup: async () => { blockerReady.resolve(undefined); await finishBlocker.promise },
    })
    try {
      await blockerReady.promise
      failure = component.error
      expect(registry.snapshot().components.find(entry => entry.id === component.id))
        .toMatchObject({ status: 'failed', retryable: false })
      let outcome: Awaited<ReturnType<typeof settle<void>>> | undefined
      void settle(component.retry()).then(result => { outcome = result })
      await drainMicrotasks(100)
      expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'COMPONENT_RETRY_UNSAFE' } })
      expect(component.error).toBe(failure)
    } finally {
      finishBlocker.resolve(undefined)
      await retry
      await settle(registry.dispose())
    }
    expect(attempts).toBe(2)
    expect(component.error).toBe(failure)
  })

  it('rejects a cached retry after a new activation fails and its Provider starts retiring', async () => {
    const registry = new CapabilityRegistry()
    const input = createCapabilityKey<string>('retry.failed.missing')
    const provider = registry.mount({
      label: 'provider', requires: [], provides: [input], setup: context => context.provide(input, 'value'),
    })
    const blockerReady = createDeferred<void>()
    const finishBlocker = createDeferred<void>()
    let attempts = 0
    const component = registry.mount({
      label: 'failed retry', requires: [input], provides: [],
      setup: () => { attempts += 1; throw new Error('activation failed safely') },
    })
    await registry.whenQuiescent()
    const retry = component.retry()
    registry.mount({
      label: 'unrelated activation', requires: [], provides: [],
      setup: async () => { blockerReady.resolve(undefined); await finishBlocker.promise },
    })
    let release: Promise<void> | undefined
    try {
      await blockerReady.promise
      const failure = component.error
      release = provider.dispose()
      let outcome: Awaited<ReturnType<typeof settle<void>>> | undefined
      void settle(component.retry()).then(result => { outcome = result })
      await drainMicrotasks(100)
      expect(outcome).toMatchObject({
        status: 'rejected', reason: { code: 'COMPONENT_RETRY_UNSATISFIED', missingKeys: [input.name] },
      })
      expect(component.status).toBe('failed')
      expect(component.error).toBe(failure)
    } finally {
      finishBlocker.resolve(undefined)
      await retry
      await release
      await registry.dispose()
    }
    expect(attempts).toBe(2)
  })
})

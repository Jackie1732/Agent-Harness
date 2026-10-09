import { describe, expect, it } from 'vitest'
import { CapabilityRegistry, createCapabilityKey, createEventName } from '../../src/index.js'
import type { ComponentHandle } from '../../src/index.js'
import { createDeferred, drainMicrotasks, settle } from '../helpers/deferred.js'

type WaitOutcome = Awaited<ReturnType<typeof settle<void>>>

describe('Scope callbacks waiting for Component reconciliation', () => {
  it.each(['root', 'derived'] as const)('rejects a Registry barrier from a closing %s callback outside Components', async kind => {
    const registry = new CapabilityRegistry()
    const scope = kind === 'root' ? registry.scope : registry.scope.derive('external callback')
    const event = createEventName<void>(`external.closing.${kind}`)
    const ready = createDeferred<void>(), rescue = createDeferred<void>()
    let waitOutcome: WaitOutcome | undefined
    scope.on(event, 'close and wait', async () => {
      expect(await settle(registry.dispose())).toMatchObject({ status: 'rejected', reason: { code: 'SCOPE_REENTRANT_WAIT' } })
      const observed = settle(registry.whenQuiescent().then(() => undefined)).then(result => { waitOutcome = result })
      ready.resolve(undefined)
      await Promise.race([observed, rescue.promise])
    })
    const emission = settle(scope.emit(event, undefined))
    try {
      await ready.promise
      await drainMicrotasks(100)
      expect(waitOutcome).toMatchObject({ status: 'rejected', reason: { code: 'SCOPE_REENTRANT_WAIT' } })
    } finally {
      rescue.resolve(undefined)
      await emission
      await registry.dispose()
    }
    expect(registry.status).toBe('disposed')
  })

  it('joins an already settled release from a later Component cleanup', async () => {
    const registry = new CapabilityRegistry()
    const released = registry.mount({ label: 'already released', requires: [], provides: [], setup: () => {} })
    await registry.whenQuiescent()
    const task = released.dispose()
    await task
    const later = registry.mount({ label: 'later cleanup', requires: [], provides: [], setup: async context => {
      await context.apply('resource', () => undefined, async () => {
        expect(released.dispose()).toBe(task)
        await released.dispose()
      })
    } })
    try {
      await registry.whenQuiescent()
      await later.dispose()
      expect(later.error).toBeUndefined()
    } finally { await registry.dispose() }
  })

  it('rejects a Registry barrier after self-release while accepting callback mutations', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('self.release.barrier')
    const callbackReady = createDeferred<void>()
    const rescue = createDeferred<void>()
    let releaseOutcome: WaitOutcome | undefined
    let waitOutcome: WaitOutcome | undefined
    let mounted: ComponentHandle | undefined
    let component: ComponentHandle
    component = registry.mount({
      label: 'self releasing', requires: [], provides: [],
      setup: context => {
        context.scope.on(event, 'self release', async () => {
          releaseOutcome = await settle(component.dispose())
          mounted = registry.mount({ label: 'mounted by callback', requires: [], provides: [], setup: () => {} })
          const observed = settle(registry.whenQuiescent().then(() => undefined)).then(result => { waitOutcome = result })
          callbackReady.resolve(undefined)
          await Promise.race([observed, rescue.promise])
        })
      },
    })
    await registry.whenQuiescent()
    const emission = settle(registry.scope.emit(event, undefined))
    try {
      await callbackReady.promise
      await drainMicrotasks(100)
      expect(releaseOutcome).toMatchObject({ status: 'rejected', reason: { code: 'SCOPE_REENTRANT_WAIT' } })
      expect(waitOutcome).toMatchObject({ status: 'rejected', reason: { code: 'SCOPE_REENTRANT_WAIT' } })
    } finally {
      rescue.resolve(undefined)
      await emission
      await settle(component.dispose())
      await registry.whenQuiescent()
    }
    expect(mounted?.status).toBe('active')
    expect(component.status).toBe('disposed')
    await registry.dispose()
  })

  it.each([['direct', false], ['indirect', true]] as const)('rejects Provider release awaited by its %s Consumer Frame', async (_label, indirect) => {
    const registry = new CapabilityRegistry()
    const input = createCapabilityKey<string>(`scope.provider.${indirect}`)
    const output = createCapabilityKey<string>(`scope.middle.${indirect}`)
    const event = createEventName<void>(`scope.release.${indirect}`)
    const callbackReady = createDeferred<void>()
    const rescue = createDeferred<void>()
    let outcome: WaitOutcome | undefined
    const provider = registry.mount({
      label: 'provider', requires: [], provides: [input],
      setup: context => context.provide(input, 'value'),
    })
    if (indirect) {
      registry.mount({
        label: 'middle', requires: [input], provides: [output],
        setup: context => context.provide(output, context.require(input)),
      })
    }
    const consumer = registry.mount({
      label: 'consumer', requires: [indirect ? output : input], provides: [],
      setup: context => {
        context.scope.on(event, 'release provider', async () => {
          const observed = settle(provider.dispose()).then(result => { outcome = result })
          callbackReady.resolve(undefined)
          await Promise.race([observed, rescue.promise])
        })
      },
    })
    await registry.whenQuiescent()
    const emission = settle(registry.scope.emit(event, undefined))
    try {
      await callbackReady.promise
      await drainMicrotasks(100)
      expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'SCOPE_REENTRANT_WAIT' } })
    } finally {
      rescue.resolve(undefined)
      await emission
      await provider.dispose()
    }
    expect(provider.status).toBe('disposed')
    expect(consumer.status).toBe('unsatisfied')
    await registry.dispose()
  })

  it('allows an accepting callback to wait for reconciliation and release an unrelated Component', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('scope.unrelated')
    const unrelated = registry.mount({ label: 'unrelated', requires: [], provides: [], setup: () => {} })
    const callbackReady = createDeferred<void>()
    const rescue = createDeferred<void>()
    let barrierOutcome: WaitOutcome | undefined
    let releaseOutcome: WaitOutcome | undefined
    const consumer = registry.mount({
      label: 'callback owner', requires: [], provides: [],
      setup: context => {
        context.scope.on(event, 'normal waits', async () => {
          const observed = (async () => {
            barrierOutcome = await settle(registry.whenQuiescent().then(() => undefined))
            releaseOutcome = await settle(unrelated.dispose())
          })()
          callbackReady.resolve(undefined)
          await Promise.race([observed, rescue.promise])
        })
      },
    })
    await registry.whenQuiescent()
    const emission = settle(registry.scope.emit(event, undefined))
    try {
      await callbackReady.promise
      await drainMicrotasks(100)
      expect(barrierOutcome).toEqual({ status: 'fulfilled', value: undefined })
      expect(releaseOutcome).toEqual({ status: 'fulfilled', value: undefined })
    } finally {
      rescue.resolve(undefined)
      await emission
      await registry.dispose()
    }
    expect(consumer.status).toBe('disposed')
  })

  it('allows a later branch carrying settled callback tokens to wait and release its Component', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('scope.settled')
    const later = createDeferred<void>()
    let branch: Promise<void> | undefined
    let component: ComponentHandle
    component = registry.mount({
      label: 'settled callback', requires: [], provides: [],
      setup: context => {
        context.scope.on(event, 'detached branch', () => {
          branch = later.promise.then(async () => {
            await registry.whenQuiescent()
            await component.dispose()
          })
        })
      },
    })
    await registry.whenQuiescent()
    await registry.scope.emit(event, undefined)
    later.resolve(undefined)
    try {
      await expect(branch).resolves.toBeUndefined()
      expect(component.status).toBe('disposed')
    } finally {
      await registry.dispose()
    }
  })
})

import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  ComponentDeactivationFailedError,
  ComponentRetryUnsafeError,
  createCapabilityKey,
} from '../../src/index.js'
import type { CapabilityKey } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'

let keyCounter = 0
function key<T>(name?: string): CapabilityKey<T> {
  keyCounter += 1
  return createCapabilityKey<T>(name ?? `edge.key.${keyCounter}`)
}

describe('capability registry edge cases', () => {
  it('never activates components that declare a cycle', async () => {
    const alpha = key('cycle.alpha')
    const beta = key('cycle.beta')
    const registry = new CapabilityRegistry()
    let setups = 0

    const first = registry.mount({
      label: 'A',
      requires: [beta],
      provides: [alpha],
      setup: () => {
        setups += 1
      },
    })
    const second = registry.mount({
      label: 'B',
      requires: [alpha],
      provides: [beta],
      setup: () => {
        setups += 1
      },
    })

    const snapshot = await registry.whenQuiescent()

    expect(setups).toBe(0)
    expect(first.status).toBe('unsatisfied')
    expect(second.status).toBe('unsatisfied')
    // Both keys are declared as offered, and neither component satisfies its
    // requirement, so the cycle is visible from declarations alone.
    // Each key is offered by one component and required by the other, and neither
    // requirement can ever resolve.
    expect([...snapshot.declarations[alpha.name]!].sort()).toEqual([first.id, second.id].sort())
    expect([...snapshot.declarations[beta.name]!].sort()).toEqual([first.id, second.id].sort())
    expect(snapshot.providers).toEqual([])
    expect(snapshot.unresolved[alpha.name]).toEqual([second.id])
    expect(snapshot.unresolved[beta.name]).toEqual([first.id])
    await registry.dispose()
  })

  it('activates a three-level chain in dependency order and stops it in reverse', async () => {
    const alpha = key('chain.alpha')
    const beta = key('chain.beta')
    const registry = new CapabilityRegistry()
    const started: string[] = []
    const cleaned: string[] = []

    const root = registry.mount({
      label: 'ROOT',
      requires: [],
      provides: [alpha],
      setup: async context => {
        started.push('ROOT')
        context.provide(alpha, 'alpha')
        await context.apply('root-lease', () => undefined, () => {
          cleaned.push('ROOT')
        })
      },
    })
    registry.mount({
      label: 'MIDDLE',
      requires: [alpha],
      provides: [beta],
      setup: async context => {
        started.push('MIDDLE')
        context.require(alpha)
        context.provide(beta, 'beta')
        await context.apply('middle-lease', () => undefined, () => {
          cleaned.push('MIDDLE')
        })
      },
    })
    registry.mount({
      label: 'LEAF',
      requires: [beta],
      provides: [],
      setup: async context => {
        started.push('LEAF')
        context.require(beta)
        await context.apply('leaf-lease', () => undefined, () => {
          cleaned.push('LEAF')
        })
      },
    })

    await registry.whenQuiescent()
    expect(started).toEqual(['ROOT', 'MIDDLE', 'LEAF'])

    // Releasing a provider makes its consumer stop first, and that consumer is itself a
    // provider for the next one, so the chain unwinds from the outside in.
    await root.dispose()
    expect(cleaned).toEqual(['LEAF', 'MIDDLE', 'ROOT'])
    expect(registry.snapshot().providers).toEqual([])
    await registry.dispose()
  })

  it('closes a component whose deactivation cleanup fails', async () => {
    const capability = key('cleanup-failure')
    const registry = new CapabilityRegistry()

    const provider = registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: async context => {
        context.provide(capability, 'value')
        await context.apply('provider-lease', () => undefined, () => {
          throw new Error('provider cleanup failed')
        })
      },
    })

    await registry.whenQuiescent()
    await expect(provider.dispose()).rejects.toBeInstanceOf(ComponentDeactivationFailedError)

    const projected = registry.snapshot().components.find(entry => entry.label === 'provider')
    expect(provider.status).toBe('disposed')
    expect(projected?.status).toBe('disposed')
    await expect(registry.dispose()).rejects.toMatchObject({ errors: [provider.error] })
  })

  it('does not retry after activation rollback leaves cleanup incomplete', async () => {
    const registry = new CapabilityRegistry()
    let attempts = 0
    const handle = registry.mount({
      label: 'unsafe-activation-retry',
      requires: [],
      provides: [],
      setup: async context => {
        attempts += 1
        await context.apply('leaked-lease', () => undefined, () => {
          throw new Error('rollback failed')
        })
        throw new Error('setup failed')
      },
    })

    await registry.whenQuiescent().catch(() => undefined)

    expect(handle.status).toBe('failed')
    expect(registry.snapshot().components.find(entry => entry.id === handle.id)).toMatchObject({
      retryable: false,
    })
    await expect(handle.retry()).rejects.toBeInstanceOf(ComponentRetryUnsafeError)
    expect(attempts).toBe(1)
    const failure = handle.error
    await expect(handle.dispose()).rejects.toBe(failure)
    expect(handle.status).toBe('disposed')
    expect(handle.error).toBe(failure)
    expect(registry.snapshot().components.find(entry => entry.id === handle.id)?.failure).toMatchObject({
      code: 'COMPONENT_ACTIVATION_FAILED',
    })
    await expect(registry.dispose()).rejects.toMatchObject({
      errors: [failure],
    })
  })

  it('stops a component instead of restarting it when automatic cleanup fails', async () => {
    const capability = key('automatic-cleanup-failure')
    const registry = new CapabilityRegistry()

    // The provider leaves, which makes the consumer deactivate without an explicit release.
    const holder = registry.mount({
      label: 'holder',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'value')
      },
    })
    const consumer = registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: async context => {
        await context.apply('consumer-lease', () => undefined, () => {
          throw new Error('consumer cleanup failed')
        })
      },
    })

    await registry.whenQuiescent()
    expect(consumer.status).toBe('active')

    await holder.dispose()

    expect(consumer.status).toBe('failed')
    const projected = registry.snapshot().components.find(entry => entry.label === 'consumer')
    expect(projected?.failurePhase).toBe('deactivation')
    expect(projected?.retryable).toBe(false)
    await expect(consumer.retry()).rejects.toBeInstanceOf(ComponentRetryUnsafeError)
    await expect(registry.dispose()).rejects.toBeInstanceOf(AggregateError)
  })

  it('does not publish an activation whose resolution was withdrawn', async () => {
    const capability = key('drifting')
    const registry = new CapabilityRegistry()
    const cleanupGate = createDeferred<void>()
    const cleanupStarted = createDeferred<void>()
    let cleanups = 0

    const provider = registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'value')
      },
    })
    const consumer = registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: async context => {
        context.require(capability)
        await context.apply('consumer-lease', () => undefined, async () => {
          cleanups += 1
          cleanupStarted.resolve()
          // Cleanup needs the provider that is retiring, so the provider must still be
          // published while this runs.
          await cleanupGate.promise
        })
      },
    })

    await registry.whenQuiescent()
    expect(consumer.status).toBe('active')

    // The provider leaves while the consumer is active, so the consumer deactivates first
    // and the provider stays published until that cleanup settles.
    const disposal = provider.dispose()
    await cleanupStarted.promise
    expect(registry.snapshot().providers).toHaveLength(1)

    cleanupGate.resolve()
    await disposal

    expect(cleanups).toBe(1)
    expect(consumer.status).toBe('unsatisfied')
    expect(registry.snapshot().providers).toEqual([])

    // A provider that arrives afterwards activates the consumer again.
    registry.mount({
      label: 'replacement',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'replacement')
      },
    })
    await registry.whenQuiescent()
    expect(consumer.status).toBe('active')
    await registry.dispose()
  })

  it('reports unsatisfied keys with every waiting component', async () => {
    const capability = key('shared-gap')
    const registry = new CapabilityRegistry()

    const first = registry.mount({
      label: 'first-waiter',
      requires: [capability],
      provides: [],
      setup: () => {},
    })
    const second = registry.mount({
      label: 'second-waiter',
      requires: [capability],
      provides: [],
      setup: () => {},
    })

    const snapshot = await registry.whenQuiescent()

    expect([...(snapshot.unresolved[capability.name] ?? [])].sort()).toEqual([first.id, second.id].sort())
    await registry.dispose()
  })

  it('runs no setup inside the synchronous mount call', async () => {
    const capability = key('sync-mount')
    const registry = new CapabilityRegistry()
    const order: string[] = []

    const handle = registry.mount({
      label: 'immediate',
      requires: [],
      provides: [capability],
      setup: context => {
        order.push('setup')
        context.provide(capability, 'value')
      },
    })

    // Mount only registers intent; nothing has run yet at this point.
    expect(order).toEqual([])
    await registry.whenQuiescent()
    expect(order).toEqual(['setup'])
    expect(handle.status).toBe('active')
    await registry.dispose()
  })

  it('keeps a provider published while a failed consumer still tears down', async () => {
    const capability = key('failing-dependent')
    const registry = new CapabilityRegistry()
    const publishedDuringTeardown: number[] = []

    const holder = registry.mount({
      label: 'holder',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'value')
      },
    })
    registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: async context => {
        await context.apply('lease', () => undefined, () => {
          publishedDuringTeardown.push(registry.snapshot().providers.length)
          throw new Error('fails after reading the provider')
        })
      },
    })

    await registry.whenQuiescent()
    await holder.dispose()

    // The binding was still reachable while the consumer cleaned up, even though the
    // consumer then failed.
    expect(publishedDuringTeardown).toEqual([1])
    expect(registry.snapshot().providers).toEqual([])
    await expect(registry.dispose()).rejects.toBeInstanceOf(AggregateError)
  })

  it('retries a failed activation once its requirements are satisfied', async () => {
    const capability = key('retry-success')
    const registry = new CapabilityRegistry()
    let attempts = 0

    const provider = registry.mount({
      label: 'flaky',
      requires: [capability],
      provides: [],
      setup: () => {
        attempts += 1
        if (attempts === 1) throw new Error('first attempt fails')
      },
    })
    const holder = registry.mount({
      label: 'holder',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'value')
      },
    })

    await registry.whenQuiescent()
    expect(provider.status).toBe('failed')
    expect(attempts).toBe(1)

    // The dependency is still satisfied, so an explicit retry is allowed and succeeds.
    await provider.retry()

    expect(provider.status).toBe('active')
    expect(attempts).toBe(2)
    expect(provider.error).toBeUndefined()
    await holder.dispose()
    await registry.dispose()
  })

  it('keeps a failed component failed when its requirement is still missing', async () => {
    const capability = key('retry-blocked')
    const registry = new CapabilityRegistry()

    const provider = registry.mount({
      label: 'failing',
      requires: [capability],
      provides: [],
      setup: () => {
        throw new Error('never succeeds')
      },
    })
    const holder = registry.mount({
      label: 'holder',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'value')
      },
    })

    await registry.whenQuiescent()
    expect(provider.status).toBe('failed')

    // Remove the requirement's provider, then retry: it must be refused, not attempted.
    await holder.dispose()

    await expect(provider.retry()).rejects.toMatchObject({ code: 'COMPONENT_RETRY_UNSATISFIED' })
    expect(provider.status).toBe('failed')
    await registry.dispose()
  })
})

import { describe, expect, it } from 'vitest'
import {
  CapabilityProviderConflictError,
  CapabilityRegistry,
  CapabilityUnsatisfiedError,
  ComponentInactiveError,
  createCapabilityKey,
} from '../../src/index.js'
import type { CapabilityKey, ComponentId } from '../../src/index.js'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'

let keyCounter = 0
function key<T>(name?: string): CapabilityKey<T> {
  keyCounter += 1
  return createCapabilityKey<T>(name ?? `registry.key.${keyCounter}`)
}

function componentIdOf(handle: { readonly id: ComponentId }): string {
  return String(handle.id)
}

describe('capability registry lifecycle', { timeout: 4000 }, () => {
  it('does not run setup while a required capability is missing', async () => {
    const need = key('need')
    const registry = new CapabilityRegistry()
    let setups = 0

    const handle = registry.mount({
      label: 'waiting',
      requires: [need],
      provides: [],
      setup: () => {
        setups += 1
      },
    })

    const snapshot = await registry.whenQuiescent()

    expect(setups).toBe(0)
    expect(handle.status).toBe('unsatisfied')
    expect(snapshot.unresolved[need.name]).toEqual([componentIdOf(handle)])
    await registry.dispose()
  })

  it('activates a consumer after its provider publishes', async () => {
    const capability = key<{ name: string }>('store')
    const registry = new CapabilityRegistry()
    const seen: string[] = []

    registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, { name: 'store' })
      },
    })
    const consumer = registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: context => {
        seen.push(context.require(capability).name)
      },
    })

    await registry.whenQuiescent()

    expect(seen).toEqual(['store'])
    expect(consumer.status).toBe('active')
    await registry.dispose()
  })

  it('activates a provider before a consumer mounted earlier', async () => {
    const capability = key('late-provider')
    const registry = new CapabilityRegistry()
    const order: string[] = []

    registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: () => {
        order.push('consumer')
      },
    })
    registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: context => {
        order.push('provider')
        context.provide(capability, 'value')
      },
    })

    await registry.whenQuiescent()

    expect(order).toEqual(['provider', 'consumer'])
    await registry.dispose()
  })

  it('activates exactly once when the last missing provider arrives', async () => {
    const first = key('first')
    const second = key('second')
    const registry = new CapabilityRegistry()
    let activations = 0

    registry.mount({
      label: 'provider-a',
      requires: [],
      provides: [first],
      setup: context => {
        context.provide(first, 'a')
      },
    })
    registry.mount({
      label: 'provider-b',
      requires: [],
      provides: [second],
      setup: context => {
        context.provide(second, 'b')
      },
    })
    registry.mount({
      label: 'consumer',
      requires: [first, second],
      provides: [],
      setup: () => {
        activations += 1
      },
    })

    await registry.whenQuiescent()

    expect(activations).toBe(1)
    await registry.dispose()
  })

  it('publishes every declared binding of one activation together', async () => {
    const alpha = key('alpha')
    const beta = key('beta')
    const registry = new CapabilityRegistry()
    const observed: string[][] = []

    registry.mount({
      label: 'provider',
      requires: [],
      provides: [alpha, beta],
      setup: context => {
        context.provide(alpha, 'a')
        context.provide(beta, 'b')
      },
    })
    registry.mount({
      label: 'consumer',
      requires: [alpha, beta],
      provides: [],
      setup: context => {
        observed.push([context.require(alpha) as string, context.require(beta) as string])
      },
    })

    await registry.whenQuiescent()

    expect(observed).toEqual([['a', 'b']])
    await registry.dispose()
  })

  it('never exposes a partially published activation when setup fails', async () => {
    const alpha = key('alpha')
    const beta = key('beta')
    const registry = new CapabilityRegistry()
    let consumerSetups = 0

    const provider = registry.mount({
      label: 'provider',
      requires: [],
      provides: [alpha, beta],
      setup: context => {
        context.provide(alpha, 'a')
        throw new Error('setup failed after offering one key')
      },
    })
    registry.mount({
      label: 'consumer',
      requires: [alpha],
      provides: [],
      setup: () => {
        consumerSetups += 1
      },
    })

    const snapshot = await registry.whenQuiescent()

    expect(consumerSetups).toBe(0)
    expect(provider.status).toBe('failed')
    const projected = snapshot.components.find(entry => entry.label === 'provider')
    expect(projected?.failurePhase).toBe('activation')
    expect(snapshot.providers).toEqual([])
    await registry.dispose()
  })

  it('fails activation when a declared key is never offered', async () => {
    const capability = key('required-binding')
    const registry = new CapabilityRegistry()

    const provider = registry.mount({
      label: 'forgetful',
      requires: [],
      provides: [capability],
      setup: () => {
        // Declared the key but never offered it.
      },
    })

    const snapshot = await registry.whenQuiescent()

    expect(provider.status).toBe('failed')
    expect(snapshot.providers).toEqual([])
    await registry.dispose()
  })

  it('rejects a second claim on a key that is still held', async () => {
    const capability = key('exclusive')
    const registry = new CapabilityRegistry()

    registry.mount({
      label: 'first',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'value')
      },
    })
    await registry.whenQuiescent()

    expect(() => registry.mount({
      label: 'second',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'other')
      },
    })).toThrow(CapabilityProviderConflictError)

    await registry.dispose()
  })

  it('keeps two registries independent for the same diagnostic name', async () => {
    const name = 'shared.diagnostic.name'
    const left = new CapabilityRegistry()
    const right = new CapabilityRegistry()
    const seen: string[] = []

    for (const [registry, value] of [[left, 'left'], [right, 'right']] as const) {
      const capability = createCapabilityKey<string>(name)
      registry.mount({
        label: `provider-${value}`,
        requires: [],
        provides: [capability],
        setup: context => {
          context.provide(capability, value)
        },
      })
      registry.mount({
        label: `consumer-${value}`,
        requires: [capability],
        provides: [],
        setup: context => {
          seen.push(context.require(capability))
        },
      })
    }

    await Promise.all([left.whenQuiescent(), right.whenQuiescent()])

    expect(seen.sort()).toEqual(['left', 'right'])
    await Promise.all([left.dispose(), right.dispose()])
  })

  it('reports a name conflict inside one registry', async () => {
    const registry = new CapabilityRegistry()
    const first = createCapabilityKey<string>('conflicting.name')
    const second = createCapabilityKey<string>('conflicting.name')

    registry.mount({
      label: 'first',
      requires: [first],
      provides: [],
      setup: () => {},
    })

    expect(() => registry.mount({
      label: 'second',
      requires: [second],
      provides: [],
      setup: () => {},
    })).toThrow(/CAPABILITY_KEY_NAME_CONFLICT|capability name/)

    await registry.dispose()
  })

  it('rejects a key the component did not declare', async () => {
    const declared = key('declared')
    const other = key('other')
    const registry = new CapabilityRegistry()
    let failure: unknown

    registry.mount({
      label: 'offender',
      requires: [],
      provides: [declared],
      setup: context => {
        try {
          context.require(other)
        } catch (reason) {
          failure = reason
        }
        context.provide(declared, 'value')
      },
    })

    await registry.whenQuiescent()

    expect((failure as { code?: string }).code).toBe('CAPABILITY_KEY_UNDECLARED')
    await registry.dispose()
  })

  it('deactivates a consumer before the provider it depends on', async () => {
    const capability = key('ordered')
    const registry = new CapabilityRegistry()
    const order: string[] = []

    const provider = registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: async context => {
        context.provide(capability, 'value')
        await context.apply('provider-resource', () => undefined, () => {
          order.push('provider-cleanup')
        })
      },
    })
    registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: async context => {
        context.require(capability)
        await context.apply('consumer-resource', () => undefined, () => {
          order.push('consumer-cleanup')
        })
      },
    })

    await registry.whenQuiescent()
    await provider.dispose()

    expect(order).toEqual(['consumer-cleanup', 'provider-cleanup'])
    await registry.dispose()
  })

  it('lets a consumer read its captured binding while it tears down', async () => {
    const capability = key<{ readonly name: string }>('readable')
    const registry = new CapabilityRegistry()
    const seen: string[] = []

    const provider = registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, { name: 'bound' })
      },
    })
    registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: async context => {
        const bound = context.require(capability)
        await context.apply('lease', () => bound, value => {
          seen.push(value.name)
        })
      },
    })

    await registry.whenQuiescent()
    await provider.dispose()

    expect(seen).toEqual(['bound'])
    await registry.dispose()
  })

  it('withdraws a retiring provider binding after its consumers finish', async () => {
    const capability = key('withdraw')
    const registry = new CapabilityRegistry()
    let boundDuringTeardown: unknown

    const provider = registry.mount({
      label: 'provider',
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
        await context.apply('hold', () => undefined, () => {
          boundDuringTeardown = registry.snapshot().providers.length
        })
      },
    })

    await registry.whenQuiescent()
    await provider.dispose()

    // The binding is still published while the consumer's own cleanup runs.
    expect(boundDuringTeardown).toBe(1)
    await registry.dispose()
  })

  it('releases every component on registry dispose', async () => {
    const capability = key('dispose-all')
    const registry = new CapabilityRegistry()
    const cleaned: string[] = []

    registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: async context => {
        context.provide(capability, 'value')
        await context.apply('provider-lease', () => undefined, () => {
          cleaned.push('provider')
        })
      },
    })
    registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: async context => {
        await context.apply('consumer-lease', () => undefined, () => {
          cleaned.push('consumer')
        })
      },
    })

    await registry.whenQuiescent()
    await registry.dispose()

    expect(cleaned).toEqual(['consumer', 'provider'])
    expect(registry.status).toBe('disposed')
  })

  it('reports a retry that cannot proceed because requirements are missing', async () => {
    const capability = key('retry-target')
    const registry = new CapabilityRegistry()

    const provider = registry.mount({
      label: 'failing',
      requires: [capability],
      provides: [],
      setup: () => {},
    })

    // Force the component into failed by making it activate, then retry after the
    // provider disappears: mount a provider, let it activate, then release it.
    const holder = registry.mount({
      label: 'holder',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'value')
      },
    })
    await registry.whenQuiescent()
    await holder.dispose()

    expect(provider.status).toBe('unsatisfied')
    await expect(provider.retry()).rejects.toBeInstanceOf(ComponentInactiveError)
    await registry.dispose()
  })

  it('rejects mounting after the registry was released', async () => {
    const registry = new CapabilityRegistry()
    await registry.dispose()

    expect(() => registry.mount({
      label: 'late',
      requires: [],
      provides: [],
      setup: () => {},
    })).toThrow(ComponentInactiveError)
    await expect(registry.whenQuiescent()).rejects.toBeInstanceOf(ComponentInactiveError)
  })

  it('settles the barrier only after a chained activation finishes', async () => {
    const capability = key('chained')
    const registry = new CapabilityRegistry()
    const gate = createDeferred<void>()
    const started = createDeferred<void>()
    let consumerRan = false

    registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: async context => {
        started.resolve()
        await gate.promise
        context.provide(capability, 'value')
      },
    })
    registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: () => {
        consumerRan = true
      },
    })

    await started.promise
    await drainMicrotasks()
    expect(consumerRan).toBe(false)

    gate.resolve()
    await registry.whenQuiescent()
    expect(consumerRan).toBe(true)
    await registry.dispose()
  })

  it('rejects retry for a component that is not failed', async () => {
    const registry = new CapabilityRegistry()
    const handle = registry.mount({
      label: 'healthy',
      requires: [],
      provides: [],
      setup: () => {},
    })
    await registry.whenQuiescent()

    await expect(handle.retry()).rejects.toBeInstanceOf(ComponentInactiveError)
    await registry.dispose()
  })

  it('reports unsatisfied explicitly when asked to activate without requirements', async () => {
    const capability = key('missing-for-retry')
    const registry = new CapabilityRegistry()
    const handle = registry.mount({
      label: 'blocked',
      requires: [capability],
      provides: [],
      setup: () => {},
    })
    await registry.whenQuiescent()

    const snapshot = registry.snapshot()
    const projected = snapshot.components.find(entry => entry.id === handle.id)
    expect(projected?.status).toBe('unsatisfied')
    expect(snapshot.unresolved[capability.name]).toEqual([handle.id])
    void CapabilityUnsatisfiedError
    await registry.dispose()
  })
  it('rejects a barrier taken from inside cleanup instead of deadlocking', async () => {
    const capability = key('reentrant-wait')
    const registry = new CapabilityRegistry()
    let barrierFailure: unknown
    let registrationAllowed = false

    const provider = registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: async context => {
        context.provide(capability, 'value')
        await context.apply('lease', () => undefined, async () => {
          try {
            await registry.whenQuiescent()
          } catch (reason) {
            barrierFailure = reason
          }
          // Registering work is synchronous and must stay allowed from cleanup.
          const extra = registry.mount({
            label: 'registered-from-cleanup',
            requires: [],
            provides: [],
            setup: () => {},
          })
          registrationAllowed = extra.id !== undefined
        })
      },
    })

    await registry.whenQuiescent()
    await provider.dispose()

    expect((barrierFailure as { code?: string }).code).toBe('REGISTRY_REENTRANT_WAIT')
    expect(registrationAllowed).toBe(true)
    await registry.dispose()
  })
})

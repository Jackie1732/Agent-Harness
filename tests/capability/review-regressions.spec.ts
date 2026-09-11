import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  ComponentActivationFailedError,
  ComponentDeactivationFailedError,
  ComponentInactiveError,
  createCapabilityKey,
} from '../../src/index.js'
import type { CapabilityKey, ComponentContext, ComponentHandle } from '../../src/index.js'
import { createDeferred, drainMicrotasks } from '../helpers/deferred.js'

let keyCounter = 0
function key<T>(name?: string): CapabilityKey<T> {
  keyCounter += 1
  return createCapabilityKey<T>(name ?? `review.key.${keyCounter}`)
}

describe('capability review regressions', () => {
  it('rejects invalid reconciliation bounds at construction', () => {
    for (const maxReconciliationSteps of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new CapabilityRegistry({ maxReconciliationSteps })).toThrow(TypeError)
    }
  })

  it('rejects duplicate declarations and duplicate provide calls', async () => {
    const capability = key<string>('duplicate')
    const registry = new CapabilityRegistry()

    expect(() => registry.mount({
      label: 'duplicate-requirement',
      requires: [capability, capability],
      provides: [],
      setup: () => {},
    })).toThrow(/duplicate/)
    expect(() => registry.mount({
      label: 'duplicate-offering',
      requires: [],
      provides: [capability, capability],
      setup: () => {},
    })).toThrow(/duplicate/)

    const handle = registry.mount({
      label: 'duplicate-publication',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'first')
        context.provide(capability, 'second')
      },
    })

    await registry.whenQuiescent()

    expect(handle.status).toBe('failed')
    expect(handle.error).toBeInstanceOf(ComponentActivationFailedError)
    expect((handle.error as ComponentActivationFailedError).reason).toMatchObject({
      code: 'CAPABILITY_BINDING_INVALID',
      problem: 'duplicate',
    })
    expect(registry.snapshot().providers).toEqual([])
    expect(registry.snapshot().components.find(entry => entry.id === handle.id)?.failure).toMatchObject({
      code: 'COMPONENT_ACTIVATION_FAILED',
    })
    await registry.dispose()
  })

  it('includes component identities in declaration conflict diagnostics', async () => {
    const capability = key<string>('claimed')
    const registry = new CapabilityRegistry()
    const holder = registry.mount({
      label: 'holder',
      requires: [],
      provides: [capability],
      setup: context => context.provide(capability, 'ready'),
    })

    let failure: unknown
    try {
      registry.mount({
        label: 'contender',
        requires: [],
        provides: [capability],
        setup: () => {},
      })
    } catch (reason) {
      failure = reason
    }

    expect(failure).toMatchObject({
      code: 'CAPABILITY_PROVIDER_CONFLICT',
      heldById: holder.id,
    })
    expect((failure as { requestedById?: string }).requestedById).toBeDefined()
    await registry.dispose()
  })

  it('allocates a fresh provider identity for every successful activation', async () => {
    const prerequisite = key<string>('provider-generation-input')
    const offered = key<string>('provider-generation-output')
    const registry = new CapabilityRegistry()

    const firstHolder = registry.mount({
      label: 'first-holder',
      requires: [],
      provides: [prerequisite],
      setup: context => context.provide(prerequisite, 'ready'),
    })
    const provider = registry.mount({
      label: 'reactivated-provider',
      requires: [prerequisite],
      provides: [offered],
      setup: context => context.provide(offered, context.require(prerequisite)),
    })

    await registry.whenQuiescent()
    const firstId = registry.snapshot().providers.find(entry => entry.component === provider.id)?.id

    await firstHolder.dispose()
    expect(provider.status).toBe('unsatisfied')
    registry.mount({
      label: 'second-holder',
      requires: [],
      provides: [prerequisite],
      setup: context => context.provide(prerequisite, 'ready'),
    })
    await registry.whenQuiescent()
    const secondId = registry.snapshot().providers.find(entry => entry.component === provider.id)?.id

    expect(firstId).toBeDefined()
    expect(secondId).toBeDefined()
    expect(secondId).not.toBe(firstId)
    await registry.dispose()
  })

  it('waits for an unawaited effect operation before publishing the activation', async () => {
    const capability = key<string>('unawaited-effect')
    const registry = new CapabilityRegistry()
    const operationStarted = createDeferred<void>()
    const operationGate = createDeferred<void>()
    let consumerSetups = 0

    registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: context => {
        void context.apply('operation', async () => {
          operationStarted.resolve()
          await operationGate.promise
          return 'resource'
        }, () => {})
        context.provide(capability, 'ready')
      },
    })
    registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: () => {
        consumerSetups += 1
      },
    })

    await operationStarted.promise
    await drainMicrotasks()
    expect(registry.snapshot().providers).toEqual([])
    expect(consumerSetups).toBe(0)

    operationGate.resolve()
    await registry.whenQuiescent()
    expect(consumerSetups).toBe(1)
    await registry.dispose()
  })

  it('invalidates every context operation after a failed setup settles', async () => {
    const prerequisite = key<string>('expired-input')
    const offered = key<string>('expired-output')
    const registry = new CapabilityRegistry()
    let captured: ComponentContext | undefined

    registry.mount({
      label: 'holder',
      requires: [],
      provides: [prerequisite],
      setup: context => context.provide(prerequisite, 'ready'),
    })
    registry.mount({
      label: 'failing',
      requires: [prerequisite],
      provides: [offered],
      setup: context => {
        captured = context
        throw new Error('setup failed')
      },
    })

    await registry.whenQuiescent()
    const context = captured
    if (context === undefined) throw new Error('setup did not capture its context')

    expect(() => context.signal).toThrow(ComponentInactiveError)
    expect(() => context.require(prerequisite)).toThrow(ComponentInactiveError)
    expect(() => context.provide(offered, 'late')).toThrow(ComponentInactiveError)
    await expect(context.apply('late', () => undefined, () => {})).rejects.toBeInstanceOf(ComponentInactiveError)
    await registry.dispose()
  })

  it('retains setup and cleanup failures from activation rollback', async () => {
    const registry = new CapabilityRegistry()
    const setupFailure = new Error('setup failed')
    const cleanupFailure = new Error('rollback failed')
    let cleanups = 0
    const handle = registry.mount({
      label: 'failed-rollback',
      requires: [],
      provides: [],
      setup: async context => {
        await context.apply('lease', () => undefined, () => {
          cleanups += 1
          throw cleanupFailure
        })
        throw setupFailure
      },
    })

    await registry.whenQuiescent()

    const failure = handle.error as ComponentActivationFailedError
    expect(failure.rollbackAttempted).toBe(1)
    expect(failure.reason).toBeInstanceOf(AggregateError)
    const reasons = (failure.reason as AggregateError).errors as unknown[]
    expect(reasons[0]).toMatchObject({ code: 'EFFECT_ROLLBACK_FAILED', setupReason: setupFailure })
    expect(reasons[1]).toMatchObject({ code: 'EFFECT_DISPOSAL_FAILED' })
    expect(cleanups).toBe(1)
    await handle.dispose()
    await registry.dispose()
  })

  it('shares a component release task and lets an activation failure leave failed', async () => {
    const registry = new CapabilityRegistry()
    const handle = registry.mount({
      label: 'failed-then-released',
      requires: [],
      provides: [],
      setup: () => {
        throw new Error('activation failed')
      },
    })
    await registry.whenQuiescent()
    expect(handle.status).toBe('failed')

    const first = handle.dispose()
    const second = handle.dispose()
    expect(second).toBe(first)
    await first

    expect(handle.status).toBe('disposed')
    await registry.dispose()
  })

  it('rejects explicit disposal when cleanup fails and preserves the cause', async () => {
    const registry = new CapabilityRegistry()
    const handle = registry.mount({
      label: 'failed-cleanup',
      requires: [],
      provides: [],
      setup: async context => {
        await context.apply('successful-lease', () => undefined, () => {})
        await context.apply('failing-lease', () => undefined, () => {
          throw new Error('cleanup failed')
        })
      },
    })
    await registry.whenQuiescent()

    const first = handle.dispose()
    expect(handle.dispose()).toBe(first)
    await expect(first).rejects.toBeInstanceOf(ComponentDeactivationFailedError)

    expect(handle.status).toBe('disposed')
    const failure = handle.error as ComponentDeactivationFailedError
    expect(failure).toMatchObject({ attempted: 2, failed: 1 })
    expect(failure.reason).toMatchObject({
      code: 'EFFECT_DISPOSAL_FAILED',
    })
    await registry.dispose()
  })

  it('shares registry disposal and aggregates every cleanup failure', async () => {
    const registry = new CapabilityRegistry()
    const cleaned: string[] = []
    for (const label of ['first', 'second']) {
      registry.mount({
        label,
        requires: [],
        provides: [],
        setup: async context => {
          await context.apply(`${label}-lease`, () => undefined, () => {
            cleaned.push(label)
            throw new Error(`${label} cleanup failed`)
          })
        },
      })
    }
    await registry.whenQuiescent()

    const first = registry.dispose()
    const second = registry.dispose()
    expect(second).toBe(first)
    const failure = await first.then(
      () => undefined,
      reason => reason,
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    expect((failure as AggregateError).errors.map(error =>
      (error as ComponentDeactivationFailedError).componentLabel)).toEqual(['second', 'first'])
    expect(cleaned).toEqual(['second', 'first'])
    expect(registry.status).toBe('disposed')
  })

  it('shares concurrent retries of the same failed episode', async () => {
    const registry = new CapabilityRegistry()
    let attempts = 0
    const handle = registry.mount({
      label: 'retry-once',
      requires: [],
      provides: [],
      setup: () => {
        attempts += 1
        if (attempts === 1) throw new Error('first attempt fails')
      },
    })
    await registry.whenQuiescent()

    const first = handle.retry()
    const second = handle.retry()
    expect(second).toBe(first)
    await first

    expect(attempts).toBe(2)
    expect(handle.status).toBe('active')
    await registry.dispose()
  })

  it('does not strand a barrier registered by a previous barrier reaction', async () => {
    const registry = new CapabilityRegistry()
    let secondSettled = false
    let second: Promise<unknown> | undefined

    await registry.whenQuiescent().then(() => {
      second = registry.whenQuiescent().then(snapshot => {
        secondSettled = true
        return snapshot
      })
    })
    await drainMicrotasks(8)

    expect(secondSettled).toBe(true)
    await second
    await registry.dispose()
  })

  it('allows an external barrier to wait while cleanup is running', async () => {
    const registry = new CapabilityRegistry()
    const cleanupStarted = createDeferred<void>()
    const cleanupGate = createDeferred<void>()
    const handle = registry.mount({
      label: 'slow-cleanup',
      requires: [],
      provides: [],
      setup: async context => {
        await context.apply('lease', () => undefined, async () => {
          cleanupStarted.resolve()
          await cleanupGate.promise
        })
      },
    })
    await registry.whenQuiescent()

    const disposal = handle.dispose()
    await cleanupStarted.promise
    let outcome = 'pending'
    const barrier = registry.whenQuiescent().then(
      () => { outcome = 'fulfilled' },
      () => { outcome = 'rejected' },
    )
    await drainMicrotasks()
    expect(outcome).toBe('pending')

    cleanupGate.resolve()
    await disposal
    await barrier
    expect(outcome).toBe('fulfilled')
    await registry.dispose()
  })

  it('rejects a barrier awaited by setup instead of deadlocking', async () => {
    const registry = new CapabilityRegistry()
    let failure: unknown
    registry.mount({
      label: 'reentrant-setup',
      requires: [],
      provides: [],
      setup: async () => {
        try {
          await registry.whenQuiescent()
        } catch (reason) {
          failure = reason
        }
      },
    })

    await registry.whenQuiescent()

    expect(failure).toMatchObject({ code: 'REGISTRY_REENTRANT_WAIT', task: 'activation' })
    await registry.dispose()
  })

  it('records a release requested by setup while rejecting its recursive wait', async () => {
    const registry = new CapabilityRegistry()
    let failure: unknown
    let handle: ComponentHandle

    handle = registry.mount({
      label: 'self-release',
      requires: [],
      provides: [],
      setup: async () => {
        try {
          await handle.dispose()
        } catch (reason) {
          failure = reason
        }
      },
    })

    await registry.whenQuiescent()

    expect(failure).toMatchObject({ code: 'REGISTRY_REENTRANT_WAIT', task: 'activation' })
    expect(handle.status).toBe('disposed')
    await registry.dispose()
  })

  it('rejects joining an existing release task from its own cleanup', async () => {
    const registry = new CapabilityRegistry()
    let failure: unknown
    let handle: ComponentHandle

    handle = registry.mount({
      label: 'release-from-cleanup',
      requires: [],
      provides: [],
      setup: async context => {
        await context.apply('lease', () => undefined, async () => {
          try {
            await handle.dispose()
          } catch (reason) {
            failure = reason
          }
        })
      },
    })
    await registry.whenQuiescent()

    await handle.dispose()

    expect(failure).toMatchObject({ code: 'REGISTRY_REENTRANT_WAIT', task: 'deactivation' })
    expect(handle.status).toBe('disposed')
    await registry.dispose()
  })

  it('rejects joining registry disposal from cleanup without deadlocking it', async () => {
    const registry = new CapabilityRegistry()
    let failure: unknown
    registry.mount({
      label: 'registry-dispose-from-cleanup',
      requires: [],
      provides: [],
      setup: async context => {
        await context.apply('lease', () => undefined, async () => {
          try {
            await registry.dispose()
          } catch (reason) {
            failure = reason
          }
        })
      },
    })
    await registry.whenQuiescent()

    await registry.dispose()

    expect(failure).toMatchObject({ code: 'REGISTRY_REENTRANT_WAIT', task: 'deactivation' })
    expect(registry.status).toBe('disposed')
  })

  it('rejects joining an existing retry task from its activation', async () => {
    const registry = new CapabilityRegistry()
    let attempts = 0
    let failure: unknown
    let handle: ComponentHandle
    handle = registry.mount({
      label: 'retry-from-retry',
      requires: [],
      provides: [],
      setup: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('first attempt fails')
        try {
          await handle.retry()
        } catch (reason) {
          failure = reason
        }
      },
    })
    await registry.whenQuiescent()

    await handle.retry()

    expect(failure).toMatchObject({ code: 'REGISTRY_REENTRANT_WAIT', task: 'activation' })
    expect(handle.status).toBe('active')
    await registry.dispose()
  })

  it('does not treat later descendants of setup as active lifecycle code', async () => {
    const registry = new CapabilityRegistry()
    const gate = createDeferred<void>()
    const completed = createDeferred<void>()
    let outcome: 'fulfilled' | 'rejected' | undefined
    registry.mount({
      label: 'detached-descendant',
      requires: [],
      provides: [],
      setup: () => {
        void gate.promise.then(async () => {
          try {
            await registry.whenQuiescent()
            outcome = 'fulfilled'
          } catch {
            outcome = 'rejected'
          } finally {
            completed.resolve()
          }
        })
      },
    })
    await registry.whenQuiescent()

    gate.resolve()
    await completed.promise

    expect(outcome).toBe('fulfilled')
    await registry.dispose()
  })

  it('aborts an activation after its component is explicitly released', async () => {
    const registry = new CapabilityRegistry()
    const started = createDeferred<void>()
    const escape = createDeferred<void>()
    let setupOutcome: 'aborted' | 'escaped' | undefined
    let handle: ComponentHandle

    handle = registry.mount({
      label: 'released-during-setup',
      requires: [],
      provides: [],
      setup: async context => {
        started.resolve()
        const aborted = new Promise<'aborted'>(resolve => {
          context.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
        })
        setupOutcome = await Promise.race([
          aborted,
          escape.promise.then(() => 'escaped' as const),
        ])
      },
    })

    await started.promise
    const disposal = handle.dispose()
    try {
      await drainMicrotasks(8)
      expect(setupOutcome).toBe('aborted')
    } finally {
      escape.resolve()
      await disposal
    }
    expect(handle.status).toBe('disposed')
    await registry.dispose()
  })

  it('never publishes staged bindings after a dependency retires mid-setup', async () => {
    const input = key<string>('retiring-input')
    const output = key<string>('staged-output')
    const registry = new CapabilityRegistry()
    const started = createDeferred<void>()
    const escape = createDeferred<void>()
    let consumerAborted = false
    let leafSetups = 0

    const provider = registry.mount({
      label: 'provider',
      requires: [],
      provides: [input],
      setup: context => context.provide(input, 'ready'),
    })
    const consumer = registry.mount({
      label: 'consumer',
      requires: [input],
      provides: [output],
      setup: async context => {
        context.provide(output, context.require(input))
        started.resolve()
        const aborted = new Promise<void>(resolve => {
          context.signal.addEventListener('abort', () => {
            consumerAborted = true
            resolve()
          }, { once: true })
        })
        await Promise.race([aborted, escape.promise])
      },
    })
    registry.mount({
      label: 'leaf',
      requires: [output],
      provides: [],
      setup: () => {
        leafSetups += 1
      },
    })

    await started.promise
    const disposal = provider.dispose()
    try {
      await drainMicrotasks(8)
      expect(consumerAborted).toBe(true)
    } finally {
      escape.resolve()
      await disposal
    }

    expect(consumer.status).toBe('unsatisfied')
    expect(leafSetups).toBe(0)
    expect(registry.snapshot().providers).toEqual([])
    await registry.dispose()
  })

  it('aborts an activation when an indirect provider starts retiring', async () => {
    const rootKey = key<string>('indirect-root')
    const middleKey = key<string>('indirect-middle')
    const registry = new CapabilityRegistry()
    const root = registry.mount({
      label: 'root',
      requires: [],
      provides: [rootKey],
      setup: context => context.provide(rootKey, 'root'),
    })
    registry.mount({
      label: 'middle',
      requires: [rootKey],
      provides: [middleKey],
      setup: context => context.provide(middleKey, context.require(rootKey)),
    })
    await registry.whenQuiescent()

    const started = createDeferred<void>()
    const escape = createDeferred<void>()
    let aborted = false
    const leaf = registry.mount({
      label: 'leaf',
      requires: [middleKey],
      provides: [],
      setup: async context => {
        started.resolve()
        const signal = new Promise<void>(resolve => {
          context.signal.addEventListener('abort', () => {
            aborted = true
            resolve()
          }, { once: true })
        })
        await Promise.race([signal, escape.promise])
      },
    })

    await started.promise
    const disposal = root.dispose()
    try {
      await drainMicrotasks(8)
      expect(aborted).toBe(true)
    } finally {
      escape.resolve()
      await disposal
    }

    expect(leaf.status).toBe('unsatisfied')
    await registry.dispose()
  })

  it('reports live cycles and removes disposed declarations from the graph', async () => {
    const alpha = key<string>('reported-cycle-alpha')
    const beta = key<string>('reported-cycle-beta')
    const registry = new CapabilityRegistry()
    const first = registry.mount({
      label: 'first',
      requires: [beta],
      provides: [alpha],
      setup: () => {},
    })
    const second = registry.mount({
      label: 'second',
      requires: [alpha],
      provides: [beta],
      setup: () => {},
    })

    const cyclic = await registry.whenQuiescent()
    expect(cyclic.cycles).toHaveLength(1)
    expect(new Set(cyclic.cycles[0]?.ids)).toEqual(new Set([first.id, second.id]))

    await first.dispose()
    const acyclic = registry.snapshot()
    expect(acyclic.cycles).toEqual([])
    expect(acyclic.declarations[alpha.name]).toEqual([second.id])
    await registry.dispose()
  })

  it('projects special capability names without inherited object properties', async () => {
    const prototypeKey = key<string>('__proto__')
    const constructorKey = key<string>('constructor')
    const registry = new CapabilityRegistry()
    registry.mount({
      label: 'special-provider',
      requires: [],
      provides: [prototypeKey, constructorKey],
      setup: context => {
        context.provide(prototypeKey, 'prototype')
        context.provide(constructorKey, 'constructor')
      },
    })
    const consumer = registry.mount({
      label: 'special-consumer',
      requires: [prototypeKey, constructorKey],
      provides: [],
      setup: context => {
        context.require(prototypeKey)
        context.require(constructorKey)
      },
    })

    const snapshot = await registry.whenQuiescent()
    const projected = snapshot.components.find(entry => entry.id === consumer.id)
    expect(snapshot.declarations.__proto__).toHaveLength(2)
    expect(snapshot.declarations.constructor).toHaveLength(2)
    expect(projected?.committed.__proto__).toBeDefined()
    expect(projected?.committed.constructor).toBeDefined()
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
    await registry.dispose()
  })
})

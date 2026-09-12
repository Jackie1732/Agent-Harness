import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  ComponentInactiveError,
  EventNameConflictError,
  ScopeInactiveError,
  ScopeNotPublishedError,
  createCapabilityKey,
  createEventName,
  createMiddlewareName,
} from '../../src/index.js'
import type { ComponentContext, RegistrationHandle, Scope } from '../../src/index.js'
import { createDeferred, settle } from '../helpers/deferred.js'

describe('component scope integration', () => {
  it('keeps staged contributions invisible until capability activation commits', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<number>('staged.event')
    const middleware = createMiddlewareName<string, string>('staged.middleware')
    const setupReady = createDeferred<void>()
    const finishSetup = createDeferred<void>()
    const calls: string[] = []
    let componentScope: Scope | undefined
    registry.mount({
      label: 'staged component',
      requires: [],
      provides: [],
      setup: async context => {
        componentScope = context.scope
        context.scope.on(event, 'listener', payload => {
          calls.push(`event:${payload}`)
        })
        context.scope.intercept(middleware, 'handler', request => {
          calls.push(`middleware:${request}`)
          return 'handled'
        })
        setupReady.resolve(undefined)
        await finishSetup.promise
      },
    })

    const activation = registry.whenQuiescent()
    await setupReady.promise
    await registry.scope.emit(event, 1)
    await expect(registry.scope.invoke(middleware, 'before', request => request))
      .resolves.toBe('before')
    expect(calls).toEqual([])
    const staged = componentScope
    if (staged === undefined) throw new Error('setup did not expose its scope')
    expect(() => staged.emit(event, 2)).toThrow(ScopeNotPublishedError)
    expect(() => staged.invoke(middleware, 'before')).toThrow(ScopeNotPublishedError)

    finishSetup.resolve(undefined)
    await activation
    await registry.scope.emit(event, 3)
    await expect(registry.scope.invoke(middleware, 'after')).resolves.toBe('handled')
    expect(calls).toEqual(['event:3', 'middleware:after'])
    await registry.dispose()
  })

  it.each([
    ['setup failure', true, false],
    ['binding validation failure', false, false],
    ['closed staging scope', false, true],
  ])('publishes nothing after %s', async (_case, failSetup, closeScope) => {
    const registry = new CapabilityRegistry()
    const capability = createCapabilityKey<string>(`failure.${_case}`)
    const event = createEventName<void>(`failure.${_case}`)
    let calls = 0
    const component = registry.mount({
      label: _case,
      requires: [],
      provides: [capability],
      setup: async context => {
        context.scope.on(event, 'never published', () => {
          calls += 1
        })
        if (closeScope) await context.scope.dispose()
        if (failSetup) throw new Error('setup failed')
        if (_case !== 'binding validation failure') context.provide(capability, 'value')
      },
    })

    await registry.whenQuiescent()
    expect(component.status).toBe('failed')
    expect(registry.snapshot().providers).toEqual([])
    await registry.scope.emit(event, undefined)
    expect(calls).toBe(0)
    await registry.dispose()
  })

  it('ignores a staged registration disposed before commit', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('staged.disposed')
    let registration: RegistrationHandle | undefined
    let calls = 0
    registry.mount({
      label: 'component',
      requires: [],
      provides: [],
      setup: async context => {
        registration = context.scope.on(event, 'disposed listener', () => {
          calls += 1
        })
        await registration.dispose()
      },
    })

    await registry.whenQuiescent()
    expect(registration?.status).toBe('disposed')
    await registry.scope.emit(event, undefined)
    expect(calls).toBe(0)
    await registry.dispose()
  })

  it('fails the whole activation when final name preflight conflicts', async () => {
    const registry = new CapabilityRegistry()
    const capability = createCapabilityKey<string>('conflict.capability')
    const stagedEvent = createEventName<void>('commit.conflict')
    const hostEvent = createEventName<void>('commit.conflict')
    const setupReady = createDeferred<void>()
    const finishSetup = createDeferred<void>()
    let stagedCalls = 0
    let hostCalls = 0
    const component = registry.mount({
      label: 'conflicting component',
      requires: [],
      provides: [capability],
      setup: async context => {
        context.scope.on(stagedEvent, 'staged', () => {
          stagedCalls += 1
        })
        context.provide(capability, 'value')
        setupReady.resolve(undefined)
        await finishSetup.promise
      },
    })
    const activation = registry.whenQuiescent()
    await setupReady.promise
    registry.scope.on(hostEvent, 'host', () => {
      hostCalls += 1
    })

    finishSetup.resolve(undefined)
    await activation
    expect(component.status).toBe('failed')
    expect(component.error).toMatchObject({
      cause: { code: 'EVENT_NAME_CONFLICT' },
    })
    expect(registry.snapshot().providers).toEqual([])
    await registry.scope.emit(hostEvent, undefined)
    expect(hostCalls).toBe(1)
    expect(stagedCalls).toBe(0)
    expect(() => registry.scope.emit(stagedEvent, undefined)).toThrow(EventNameConflictError)
    await registry.dispose()
  })

  it('rolls back staged contributions when an activation dependency drifts', async () => {
    const registry = new CapabilityRegistry()
    const capability = createCapabilityKey<string>('drift.capability')
    const event = createEventName<void>('drift.event')
    const provider = registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'value')
      },
    })
    await registry.whenQuiescent()
    const setupReady = createDeferred<void>()
    const finishSetup = createDeferred<void>()
    let calls = 0
    const consumer = registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: async context => {
        context.require(capability)
        context.scope.on(event, 'staged listener', () => {
          calls += 1
        })
        setupReady.resolve(undefined)
        await finishSetup.promise
      },
    })
    const activation = registry.whenQuiescent()
    await setupReady.promise
    const providerRelease = provider.dispose()
    finishSetup.resolve(undefined)
    await activation
    await providerRelease

    expect(consumer.status).toBe('unsatisfied')
    await registry.scope.emit(event, undefined)
    expect(calls).toBe(0)
    await registry.dispose()
  })

  it('preserves staged registration ordinals across a delayed commit', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('staged.ordinal')
    const setupReady = createDeferred<void>()
    const finishSetup = createDeferred<void>()
    const trace: string[] = []
    registry.mount({
      label: 'component',
      requires: [],
      provides: [],
      setup: async context => {
        context.scope.on(event, 'registered first', () => {
          trace.push('component')
        })
        setupReady.resolve(undefined)
        await finishSetup.promise
      },
    })
    const activation = registry.whenQuiescent()
    await setupReady.promise
    registry.scope.on(event, 'published first', () => {
      trace.push('host')
    })
    finishSetup.resolve(undefined)
    await activation

    await registry.scope.emit(event, undefined)
    expect(trace).toEqual(['component', 'host'])
    await registry.dispose()
  })

  it('withdraws a component scope before waiting for its frame and cleaning resources', async () => {
    const registry = new CapabilityRegistry()
    const capability = createCapabilityKey<string>('ordered.cleanup')
    const event = createEventName<void>('ordered.cleanup')
    const listenerStarted = createDeferred<void>()
    const finishListener = createDeferred<void>()
    const trace: string[] = []
    let resourceLive = false
    let calls = 0
    const component = registry.mount({
      label: 'provider',
      requires: [],
      provides: [capability],
      setup: async context => {
        await context.apply(
          'resource',
          () => {
            resourceLive = true
            return 'resource'
          },
          () => {
            trace.push('cleanup')
            resourceLive = false
          },
        )
        context.scope.on(event, 'listener', async () => {
          calls += 1
          trace.push(`listener:start:${resourceLive}`)
          listenerStarted.resolve(undefined)
          await finishListener.promise
          trace.push(`listener:end:${resourceLive}`)
        })
        context.provide(capability, 'bound')
      },
    })
    await registry.whenQuiescent()
    const emission = registry.scope.emit(event, undefined)
    await listenerStarted.promise

    const release = component.dispose()
    await registry.scope.emit(event, undefined)
    expect(calls).toBe(1)
    expect(resourceLive).toBe(true)
    expect(registry.snapshot().providers).toHaveLength(1)
    finishListener.resolve(undefined)
    await emission
    await release

    expect(trace).toEqual(['listener:start:true', 'listener:end:true', 'cleanup'])
    expect(resourceLive).toBe(false)
    expect(registry.snapshot().providers).toEqual([])
    await registry.dispose()
  })

  it('creates a fresh activation scope after dependency replacement', async () => {
    const registry = new CapabilityRegistry()
    const capability = createCapabilityKey<string>('replace.dependency')
    const scopes: Scope[] = []
    const provider = registry.mount({
      label: 'first provider',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'first')
      },
    })
    const consumer = registry.mount({
      label: 'consumer',
      requires: [capability],
      provides: [],
      setup: context => {
        context.require(capability)
        scopes.push(context.scope)
      },
    })
    await registry.whenQuiescent()
    await provider.dispose()
    expect(consumer.status).toBe('unsatisfied')
    expect(scopes[0]?.status).toBe('disposed')

    registry.mount({
      label: 'second provider',
      requires: [],
      provides: [capability],
      setup: context => {
        context.provide(capability, 'second')
      },
    })
    await registry.whenQuiescent()
    expect(consumer.status).toBe('active')
    expect(scopes).toHaveLength(2)
    expect(scopes[1]?.id === scopes[0]?.id).toBe(false)
    await registry.dispose()
  })

  it('does not create a component scope before its requirements resolve', async () => {
    const registry = new CapabilityRegistry()
    const missing = createCapabilityKey<string>('missing')
    let setupCalls = 0
    registry.mount({
      label: 'waiting',
      requires: [missing],
      provides: [],
      setup: () => {
        setupCalls += 1
      },
    })

    await registry.whenQuiescent()
    expect(setupCalls).toBe(0)
    expect(registry.scope.snapshot().scopes).toHaveLength(1)
    await registry.dispose()
  })

  it('closes the root tree before registry cleanup and rejects new extension work', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('registry.dispose')
    const started = createDeferred<void>()
    const finish = createDeferred<void>()
    let componentScope: Scope | undefined
    registry.mount({
      label: 'component',
      requires: [],
      provides: [],
      setup: context => {
        componentScope = context.scope
        context.scope.on(event, 'listener', async () => {
          started.resolve(undefined)
          await finish.promise
        })
      },
    })
    await registry.whenQuiescent()
    const emission = registry.scope.emit(event, undefined)
    await started.promise

    const disposal = registry.dispose()
    expect(registry.scope.status).toBe('disposing')
    expect(componentScope?.status).toBe('disposing')
    expect(() => registry.scope.emit(event, undefined)).toThrow(ScopeInactiveError)
    finish.resolve(undefined)
    await emission
    await disposal
    expect(registry.scope.status).toBe('disposed')
  })

  it('closes ComponentContext scope access after setup settles', async () => {
    const registry = new CapabilityRegistry()
    let savedContext: ComponentContext | undefined
    registry.mount({
      label: 'context lifetime',
      requires: [],
      provides: [],
      setup: context => {
        savedContext = context
        void context.scope
      },
    })
    await registry.whenQuiescent()
    const context = savedContext
    if (context === undefined) throw new Error('setup did not expose context')

    expect(() => context.scope).toThrow(ComponentInactiveError)
    await registry.dispose()
  })

  it('lets component disposal from its callback fail fast while cleanup continues', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('component.self.dispose')
    let component: ReturnType<CapabilityRegistry['mount']>
    let callbackOutcome: Awaited<ReturnType<typeof settle<void>>> | undefined
    component = registry.mount({
      label: 'self disposing',
      requires: [],
      provides: [],
      setup: context => {
        context.scope.on(event, 'listener', async () => {
          callbackOutcome = await settle(component.dispose())
        })
      },
    })
    await registry.whenQuiescent()

    await registry.scope.emit(event, undefined)
    expect(callbackOutcome).toMatchObject({
      status: 'rejected',
      reason: { code: 'SCOPE_REENTRANT_WAIT' },
    })
    await component.dispose()
    expect(component.status).toBe('disposed')
    await registry.dispose()
  })

  it('lets registry disposal from a root callback fail fast while shutdown continues', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('registry.self.dispose')
    let callbackOutcome: Awaited<ReturnType<typeof settle<void>>> | undefined
    registry.scope.on(event, 'listener', async () => {
      callbackOutcome = await settle(registry.dispose())
    })

    await registry.scope.emit(event, undefined)
    expect(callbackOutcome).toMatchObject({
      status: 'rejected',
      reason: { code: 'SCOPE_REENTRANT_WAIT' },
    })
    await registry.dispose()
    expect(registry.status).toBe('disposed')
  })
})

import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  ScopeReentrantWaitError,
  createEventName,
  createMiddlewareName,
} from '../../src/index.js'
import type { ScopeSnapshot } from '../../src/index.js'
import { createDeferred, settle } from '../helpers/deferred.js'

describe('scope quiescence', () => {
  it('extends an idle barrier to work accepted later in the same stack', async () => {
    const registry = new CapabilityRegistry()
    const scope = registry.scope.derive('barrier')
    const event = createEventName<void>('barrier.event')
    const started = createDeferred<void>()
    const finish = createDeferred<void>()
    scope.on(event, 'listener', async () => {
      started.resolve(undefined)
      await finish.promise
    })

    let barrierSettled = false
    const barrier = scope.whenQuiescent().then(snapshot => {
      barrierSettled = true
      return snapshot
    })
    const emission = registry.scope.emit(event, undefined)
    await started.promise
    expect(barrierSettled).toBe(false)
    finish.resolve(undefined)
    await emission
    const snapshot = await barrier
    expect(snapshot.subtreeInFlight).toBe(0)
    await registry.dispose()
  })

  it('materializes independent snapshots for concurrent barriers at one point', async () => {
    const registry = new CapabilityRegistry()
    const scope = registry.scope.derive('snapshots')
    const firstPromise = scope.whenQuiescent()
    const secondPromise = scope.whenQuiescent()
    expect(firstPromise).not.toBe(secondPromise)

    const [first, second] = await Promise.all([firstPromise, secondPromise])
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first.scopes).not.toBe(second.scopes)
    expect(first.scopes[0]).not.toBe(second.scopes[0])
    expect(first.scopes[0]?.children).not.toBe(second.scopes[0]?.children)
    expect(first.revision).toBe(second.revision)
    await registry.dispose()
  })

  it('charges an origin to its caller and a frame to its registration scope', async () => {
    const registry = new CapabilityRegistry()
    const registrationScope = registry.scope.derive('registration owner')
    const event = createEventName<void>('ownership')
    const started = createDeferred<void>()
    const finish = createDeferred<void>()
    registrationScope.on(event, 'listener', async () => {
      started.resolve(undefined)
      await finish.promise
    })

    const emission = registry.scope.emit(event, undefined)
    await started.promise
    const rootSnapshot = registry.scope.snapshot()
    const childSnapshot = registrationScope.snapshot()
    expect(rootSnapshot.scopes[0]?.ownInFlight).toBe(1)
    expect(rootSnapshot.scopes.find(node => node.id === String(registrationScope.id))?.ownInFlight).toBe(1)
    expect(rootSnapshot.subtreeInFlight).toBe(2)
    expect(childSnapshot.subtreeInFlight).toBe(1)

    finish.resolve(undefined)
    await emission
    await registry.dispose()
  })

  it('keeps an unawaited downstream continuation in the origin task', async () => {
    const registry = new CapabilityRegistry()
    const scope = registry.scope.derive('origin owner')
    const middleware = createMiddlewareName<void, string>('detached.next')
    const terminalStarted = createDeferred<void>()
    const finishTerminal = createDeferred<void>()
    scope.intercept(middleware, 'detaches next', (_request, next) => {
      void next()
      return 'outer result'
    })

    const invocation = scope.invoke(middleware, undefined, async () => {
      terminalStarted.resolve(undefined)
      await finishTerminal.promise
      return 'terminal result'
    })
    await terminalStarted.promise
    await expect(invocation).resolves.toBe('outer result')
    expect(scope.snapshot().subtreeInFlight).toBe(1)
    let barrierSettled = false
    const barrier = scope.whenQuiescent().then(snapshot => {
      barrierSettled = true
      return snapshot
    })
    expect(barrierSettled).toBe(false)

    finishTerminal.resolve(undefined)
    expect((await barrier).subtreeInFlight).toBe(0)
    await registry.dispose()
  })

  it('rejects self waits while allowing background disposal to finish', async () => {
    const registry = new CapabilityRegistry()
    const scope = registry.scope.derive('self')
    const event = createEventName<void>('self.wait')
    let waitFailure: unknown
    let disposeFailure: unknown
    scope.on(event, 'self waiter', async () => {
      const wait = await settle(scope.whenQuiescent())
      waitFailure = wait.status === 'rejected' ? wait.reason : undefined
      const disposal = await settle(scope.dispose())
      disposeFailure = disposal.status === 'rejected' ? disposal.reason : undefined
    })

    await registry.scope.emit(event, undefined)
    expect(waitFailure).toBeInstanceOf(ScopeReentrantWaitError)
    expect(disposeFailure).toBeInstanceOf(ScopeReentrantWaitError)
    await expect(scope.dispose()).resolves.toBeUndefined()
    expect(scope.status).toBe('disposed')
    await registry.dispose()
  })

  it('detects a nested A to B to A wait cycle', async () => {
    const registry = new CapabilityRegistry()
    const scopeA = registry.scope.derive('A')
    const scopeB = registry.scope.derive('B')
    const eventA = createEventName<void>('cycle.A')
    const eventB = createEventName<void>('cycle.B')
    let failure: unknown
    scopeA.on(eventA, 'A listener', async () => {
      await scopeB.emit(eventB, undefined)
    })
    scopeB.on(eventB, 'B listener', async () => {
      const outcome = await settle(scopeA.whenQuiescent())
      failure = outcome.status === 'rejected' ? outcome.reason : undefined
    })

    await scopeA.emit(eventA, undefined)
    expect(failure).toBeInstanceOf(ScopeReentrantWaitError)
    await registry.dispose()
  })

  it('allows a callback to wait for a sibling scope', async () => {
    const registry = new CapabilityRegistry()
    const source = registry.scope.derive('source')
    const sibling = registry.scope.derive('sibling')
    const event = createEventName<void>('sibling.dispose')
    source.on(event, 'listener', async () => {
      await sibling.dispose()
    })

    await source.emit(event, undefined)
    expect(sibling.status).toBe('disposed')
    await registry.dispose()
  })

  it('ignores settled task tokens retained by an asynchronous branch', async () => {
    const registry = new CapabilityRegistry()
    const scope = registry.scope.derive('stale context')
    const event = createEventName<void>('stale.context')
    const continueBranch = createDeferred<void>()
    let lateWait: Promise<ScopeSnapshot> | undefined
    scope.on(event, 'listener', () => {
      lateWait = continueBranch.promise.then(() => scope.whenQuiescent())
    })

    await scope.emit(event, undefined)
    continueBranch.resolve(undefined)
    const wait = lateWait
    if (wait === undefined) throw new Error('listener did not create late wait')
    await expect(wait).resolves.toMatchObject({ subtreeInFlight: 0 })
    await registry.dispose()
  })

  it('detects a terminal waiting for its own origin scope', async () => {
    const registry = new CapabilityRegistry()
    const scope = registry.scope.derive('terminal origin')
    const middleware = createMiddlewareName<void, unknown>('terminal.wait')

    const result = await scope.invoke(middleware, undefined, async () => {
      return await settle(scope.whenQuiescent())
    })
    expect(result).toMatchObject({
      status: 'rejected',
      reason: { code: 'SCOPE_REENTRANT_WAIT' },
    })
    await registry.dispose()
  })

  it('uses one tree-wide revision across sibling mutations', async () => {
    const registry = new CapabilityRegistry()
    const first = registry.scope.derive('first')
    const second = registry.scope.derive('second')
    const before = first.snapshot().revision
    second.on(createEventName('revision'), 'listener', () => undefined)
    const after = first.snapshot().revision

    expect(after).toBeGreaterThan(before)
    await registry.dispose()
  })

  it('keeps disposal pending while admitted user work is pending', async () => {
    const registry = new CapabilityRegistry()
    const scope = registry.scope.derive('blocked')
    const event = createEventName<void>('blocked.dispose')
    const started = createDeferred<void>()
    const finish = createDeferred<void>()
    scope.on(event, 'blocking listener', async () => {
      started.resolve(undefined)
      await finish.promise
    })
    const emission = scope.emit(event, undefined)
    await started.promise

    const disposal = scope.dispose()
    expect(scope.status).toBe('disposing')
    finish.resolve(undefined)
    await emission
    await disposal
    expect(scope.status).toBe('disposed')
    await registry.dispose()
  })
})

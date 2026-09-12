import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  ScopeInactiveError,
  assertJsonValue,
  createEventName,
  createMiddlewareName,
} from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'

describe('extension scopes', () => {
  it('requires labels and treats repeated registrations as independent', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('repeated')
    const middleware = createMiddlewareName<void, void>('labeled')
    let calls = 0
    const listener = (): void => {
      calls += 1
    }

    expect(() => registry.scope.derive('')).toThrow(TypeError)
    expect(() => registry.scope.on(event, '', listener)).toThrow(TypeError)
    expect(() => registry.scope.intercept(middleware, '', () => undefined)).toThrow(TypeError)
    const first = registry.scope.on(event, 'same', listener)
    const second = registry.scope.on(event, 'same', listener)
    expect(first.id === second.id).toBe(false)
    await registry.scope.emit(event, undefined)
    expect(calls).toBe(2)
    await first.dispose()
    await registry.scope.emit(event, undefined)
    expect(calls).toBe(3)
    await registry.dispose()
  })

  it('uses a root facade with no runtime dispose escape', async () => {
    const registry = new CapabilityRegistry()
    const root = registry.scope as object

    expect('dispose' in root).toBe(false)
    let prototype: object | null = root
    while (prototype !== null) {
      expect(Object.prototype.hasOwnProperty.call(prototype, 'dispose')).toBe(false)
      prototype = Object.getPrototypeOf(prototype) as object | null
    }
    await registry.dispose()
  })

  it('projects a JSON-safe flat subtree in creation and registration order', async () => {
    const registry = new CapabilityRegistry()
    const parent = registry.scope.derive('same label')
    const firstChild = parent.derive('same label')
    const secondChild = parent.derive('other child')
    const event = createEventName<void>('snapshot.event')
    const middleware = createMiddlewareName<void, void>('snapshot.middleware')
    firstChild.intercept(middleware, 'handler', () => undefined)
    secondChild.on(event, 'listener', () => undefined)

    const snapshot = parent.snapshot()
    expect(snapshot.scopes.map(scope => scope.id)).toEqual([
      String(parent.id),
      String(firstChild.id),
      String(secondChild.id),
    ])
    expect(snapshot.scopes[0]?.children).toEqual([String(firstChild.id), String(secondChild.id)])
    expect(snapshot.scopes[1]?.parent).toBe(String(parent.id))
    expect(snapshot.scopes[2]?.registrations[0]?.name).toBe('snapshot.event')
    expect(() => assertJsonValue(snapshot)).not.toThrow()
    await parent.dispose()
    await registry.dispose()
  })

  it('releases one registration immediately and idempotently', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('registration.dispose')
    let calls = 0
    const registration = registry.scope.on(event, 'listener', () => {
      calls += 1
    })

    const first = registration.dispose()
    const second = registration.dispose()
    expect(first).toBe(second)
    expect(registration.status).toBe('disposed')
    await first
    await registry.scope.emit(event, undefined)
    expect(calls).toBe(0)
    await registry.dispose()
  })

  it('closes an entire subtree synchronously and waits for started frames', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('scope.dispose')
    const parent = registry.scope.derive('parent')
    const child = parent.derive('child')
    const started = createDeferred<void>()
    const finish = createDeferred<void>()
    const registration = child.on(event, 'blocking listener', async () => {
      started.resolve(undefined)
      await finish.promise
    })
    const emission = registry.scope.emit(event, undefined)
    await started.promise

    const disposal = parent.dispose()
    expect(parent.status).toBe('disposing')
    expect(child.status).toBe('disposing')
    expect(parent.signal.aborted).toBe(true)
    expect(child.signal.aborted).toBe(true)
    expect(registration.status).toBe('disposed')
    finish.resolve(undefined)
    await emission
    await disposal
    expect(child.status).toBe('disposed')
    expect(parent.status).toBe('disposed')
    await registry.dispose()
  })

  it('rejects all mutating and invocation entries after disposal', async () => {
    const registry = new CapabilityRegistry()
    const scope = registry.scope.derive('closed')
    const event = createEventName<void>('closed.event')
    const middleware = createMiddlewareName<void, void>('closed.middleware')
    await scope.dispose()

    const operations = [
      () => scope.on(event, 'listener', () => undefined),
      () => scope.intercept(middleware, 'handler', () => undefined),
      () => scope.derive('child'),
      () => scope.emit(event, undefined),
      () => scope.invoke(middleware, undefined, () => undefined),
    ]
    for (const operation of operations) {
      try {
        await operation()
        expect.unreachable('inactive scope operation succeeded')
      } catch (reason) {
        expect(reason).toBeInstanceOf(ScopeInactiveError)
      }
    }
    expect(scope.snapshot().status).toBe('disposed')
    await registry.dispose()
  })

  it('does not replay an event callback failure through scope disposal', async () => {
    const registry = new CapabilityRegistry()
    const scope = registry.scope.derive('failure owner')
    const event = createEventName<void>('failure')
    scope.on(event, 'failing', () => {
      throw new Error('callback failed')
    })

    await expect(registry.scope.emit(event, undefined)).rejects.toMatchObject({
      code: 'EVENT_LISTENERS_FAILED',
    })
    await expect(scope.dispose()).resolves.toBeUndefined()
    await registry.dispose()
  })
})

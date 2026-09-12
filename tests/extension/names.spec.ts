import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  EventNameConflictError,
  MiddlewareNameConflictError,
  createEventName,
  createMiddlewareName,
} from '../../src/index.js'

describe('extension names', () => {
  it('creates frozen identities and rejects empty diagnostic names', () => {
    const event = createEventName<number>('test.event')
    const middleware = createMiddlewareName<string, number>('test.middleware')

    expect(event.name).toBe('test.event')
    expect(middleware.name).toBe('test.middleware')
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(middleware)).toBe(true)
    expect(() => createEventName('')).toThrow(TypeError)
    expect(() => createMiddlewareName('')).toThrow(TypeError)
  })

  it('rejects different event identities with one live name', async () => {
    const registry = new CapabilityRegistry()
    const first = createEventName<void>('shared')
    const second = createEventName<void>('shared')
    registry.scope.on(first, 'first', () => undefined)

    expect(() => registry.scope.on(second, 'second', () => undefined))
      .toThrow(EventNameConflictError)
    expect(() => registry.scope.emit(second, undefined)).toThrow(EventNameConflictError)
    await registry.dispose()
  })

  it('keeps event and middleware namespaces separate and releases names', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('shared')
    const middleware = createMiddlewareName<void, string>('shared')
    const eventRegistration = registry.scope.on(event, 'event', () => undefined)
    const middlewareRegistration = registry.scope.intercept(
      middleware,
      'middleware',
      () => 'short-circuit',
    )

    await registry.scope.emit(event, undefined)
    await expect(registry.scope.invoke(middleware, undefined)).resolves.toBe('short-circuit')
    await eventRegistration.dispose()
    await middlewareRegistration.dispose()

    const replacementEvent = createEventName<void>('shared')
    const replacementMiddleware = createMiddlewareName<void, string>('shared')
    registry.scope.on(replacementEvent, 'replacement event', () => undefined)
    registry.scope.intercept(replacementMiddleware, 'replacement middleware', () => 'replacement')
    await registry.dispose()
  })

  it('rejects different middleware identities with one live name', async () => {
    const registry = new CapabilityRegistry()
    const first = createMiddlewareName<void, void>('duplicate')
    const second = createMiddlewareName<void, void>('duplicate')
    registry.scope.intercept(first, 'first', () => undefined)

    expect(() => registry.scope.intercept(second, 'second', () => undefined))
      .toThrow(MiddlewareNameConflictError)
    expect(() => registry.scope.invoke(second, undefined, () => undefined))
      .toThrow(MiddlewareNameConflictError)
    await registry.dispose()
  })
})

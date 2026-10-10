import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import { CapabilityRegistry, createEventName, createMiddlewareName } from '../../src/index.js'
import type { RegistrationHandle, Scope } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'

it('retires replaced listener and middleware captures while their Handles and tree remain reachable', async () => {
  class Resource { value = 0 }
  const registry = new CapabilityRegistry(), handles: RegistrationHandle[] = []
  const event = createEventName<void>('retention.replacements.event')
  const middleware = createMiddlewareName<void, number>('retention.replacements.middleware')
  function register(): RegistrationHandle[] {
    const listenerResource = new Resource(), handlerResource = new Resource()
    return [
      registry.scope.on(event, 'listener', () => { listenerResource.value++ }),
      registry.scope.intercept(middleware, 'handler', () => ++handlerResource.value),
    ]
  }
  expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  try {
    for (let index = 0; index < 20; index++) {
      const registrations = register()
      handles.push(...registrations)
      await registry.scope.emit(event, undefined)
      await expect(registry.scope.invoke(middleware, undefined)).resolves.toBe(1)
      await Promise.all(registrations.map(handle => handle.dispose()))
    }
    await setImmediate()
    expect(queryObjects(Resource, { format: 'count' })).toBe(0)
    expect(registry.scope.status).toBe('accepting')
    expect(registry.scope.snapshot().scopes[0]?.registrations).toEqual([])
    expect(handles).toHaveLength(40)
    for (const handle of handles) {
      expect(handle.status).toBe('disposed')
      expect(Object.hasOwn(handle.constructor, 'retire')).toBe(false)
      expect(Object.hasOwn(handle.constructor, 'create')).toBe(false)
      expect(handle.scopeId).toBe(registry.scope.id)
      const release = handle.dispose()
      expect(handle.dispose()).toBe(release)
      await release
    }
  } finally { await registry.dispose() }
})

it('retires an unpublished callback capture after activation rollback', async () => {
  class Resource { value = 0 }
  const registry = new CapabilityRegistry(), event = createEventName<void>('retention.staging')
  let handle: RegistrationHandle | undefined
  const component = registry.mount({ label: 'failed setup', requires: [], provides: [], setup: context => {
    const resource = new Resource()
    handle = context.scope.on(event, 'unpublished callback', () => { resource.value++ })
    throw new Error('setup failed')
  } })
  expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  try {
    await registry.whenQuiescent()
    await setImmediate()
    expect(queryObjects(Resource, { format: 'count' })).toBe(0)
    expect(component.status).toBe('failed')
    const registration = handle
    if (registration === undefined) throw new Error('setup did not register its callback')
    expect(registration.status).toBe('disposed')
    const release = registration.dispose()
    expect(registration.dispose()).toBe(release)
    await release
    await registry.scope.emit(event, undefined)
  } finally { await registry.dispose() }
})

it('keeps terminal Handle diagnostics without retaining the closed tree or neighboring callbacks', async () => {
  class Resource { value = 0 }
  async function closeTree(): Promise<RegistrationHandle> {
    const registry = new CapabilityRegistry()
    const scope = registry.scope.derive('retained handle scope')
    function register(owner: Scope): RegistrationHandle {
      const resource = new Resource()
      return owner.on(createEventName<void>(owner.label), 'diagnostic registration', () => { resource.value++ })
    }
    const handle = register(scope)
    register(registry.scope.derive('neighboring scope'))
    await registry.dispose()
    return handle
  }
  expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  const handle = await closeTree()
  await setImmediate()
  expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  expect(handle.status).toBe('disposed')
  expect(handle.id).toBe('r1')
  expect(handle.scopeId).toBe('s2')
  expect(handle.label).toBe('diagnostic registration')
  const release = handle.dispose()
  expect(handle.dispose()).toBe(release)
  await release
})

it.each(['listener', 'middleware'] as const)('retains an admitted %s capture until its Frame settles', async kind => {
  class Resource { value = 0 }
  const registry = new CapabilityRegistry()
  const scope = registry.scope.derive('in-flight callback')
  const event = createEventName<void>('retention.in-flight.event')
  const middleware = createMiddlewareName<void, number>('retention.in-flight.middleware')
  const started = createDeferred<void>(), finish = createDeferred<void>()
  let observed: number | undefined
  function register(): RegistrationHandle {
    const resource = new Resource()
    const callback = async (): Promise<number> => {
      started.resolve(undefined)
      await finish.promise
      observed = ++resource.value
      return observed
    }
    return kind === 'listener'
      ? scope.on(event, 'callback', async () => { await callback() })
      : scope.intercept(middleware, 'callback', callback)
  }
  expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  const handle = register()
  const dispatch = kind === 'listener'
    ? registry.scope.emit(event, undefined)
    : registry.scope.invoke(middleware, undefined)
  try {
    await started.promise
    const release = handle.dispose()
    expect(handle.status).toBe('disposed')
    expect(handle.dispose()).toBe(release)
    await release
    await setImmediate()
    expect(queryObjects(Resource, { format: 'count' })).toBe(1)
    expect(scope.snapshot().subtreeInFlight).toBe(1)
    finish.resolve(undefined)
    await dispatch
    await scope.whenQuiescent()
    await setImmediate()
    expect(observed).toBe(1)
    expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  } finally {
    finish.resolve(undefined)
    await Promise.allSettled([dispatch, registry.dispose()])
  }
})

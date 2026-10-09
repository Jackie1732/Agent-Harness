import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { queryObjects } from 'node:v8'
import { CapabilityRegistry, createCapabilityKey, createEventName, createMiddlewareName } from '../dist/index.js'

test('built activation publication rollback rejects its own coordinator wait', async () => {
  const registry = new CapabilityRegistry(), key = createCapabilityKey('built-missing-binding')
  const rescue = Promise.withResolvers(), entered = Promise.withResolvers()
  let outcome, reversions = 0
  const component = registry.mount({ label: 'missing binding', requires: [], provides: [key], setup: async context => {
    await context.apply('resource', () => undefined, async () => {
      const observed = registry.whenQuiescent().then(() => { outcome = 'fulfilled' }, reason => { outcome = reason.code })
      entered.resolve()
      await Promise.race([observed, rescue.promise])
      reversions++
    })
  } })
  const barrier = registry.whenQuiescent()
  try {
    await entered.promise
    await setImmediate()
    assert.equal(outcome, 'REGISTRY_REENTRANT_WAIT')
    await barrier
    assert.equal(component.status, 'failed')
    assert.equal(component.error.code, 'COMPONENT_ACTIVATION_FAILED')
    assert.equal(reversions, 1)
    assert.deepEqual(registry.snapshot().providers, [])
  } finally {
    rescue.resolve()
    await barrier
    await registry.dispose()
  }
})

test('built Consumer Frame cannot await Provider retirement that needs that Frame', async () => {
  const registry = new CapabilityRegistry(), key = createCapabilityKey('built-frame-provider')
  const event = createEventName('built-frame-release'), ready = Promise.withResolvers(), rescue = Promise.withResolvers()
  let outcome
  const provider = registry.mount({ label: 'provider', requires: [], provides: [key], setup: context => context.provide(key, 'value') })
  const consumer = registry.mount({ label: 'consumer', requires: [key], provides: [], setup: context => {
    context.scope.on(event, 'retire dependency', async () => {
      const observed = provider.dispose().then(() => { outcome = 'fulfilled' }, reason => { outcome = reason.code })
      ready.resolve()
      await Promise.race([observed, rescue.promise])
    })
  } })
  await registry.whenQuiescent()
  const emission = registry.scope.emit(event, undefined)
  try {
    await ready.promise
    await setImmediate()
    assert.equal(outcome, 'SCOPE_REENTRANT_WAIT')
    await emission
    await provider.dispose()
    assert.equal(consumer.status, 'unsatisfied')
  } finally {
    rescue.resolve()
    await emission
    await registry.dispose()
  }
})

test('built Root Frame cannot wait for a Registry whose shutdown joins that Frame', async () => {
  const registry = new CapabilityRegistry(), ready = Promise.withResolvers(), rescue = Promise.withResolvers()
  const event = createEventName('built-root-closing')
  let outcome
  registry.scope.on(event, 'close and wait', async () => {
    await assert.rejects(registry.dispose(), { code: 'SCOPE_REENTRANT_WAIT' })
    const observed = registry.whenQuiescent().then(() => { outcome = 'fulfilled' }, reason => { outcome = reason.code })
    ready.resolve()
    await Promise.race([observed, rescue.promise])
  })
  const emission = registry.scope.emit(event, undefined)
  try {
    await ready.promise
    await setImmediate()
    assert.equal(outcome, 'SCOPE_REENTRANT_WAIT')
  } finally {
    rescue.resolve()
    await emission
    await registry.dispose()
  }
  assert.equal(registry.status, 'disposed')
})

test('built disposal after completed Root dispatch observes every Component retirement', async () => {
  const registry = new CapabilityRegistry(), key = createCapabilityKey('built-completed-dispatch')
  const event = createEventName('built-completed-event'), middleware = createMiddlewareName('built-completed-middleware')
  let cleaned = 0
  const provider = registry.mount({ label: 'provider', requires: [], provides: [key], setup: async context => {
    context.provide(key, await context.apply('resource', () => 'value', () => { cleaned++ }))
  } })
  const consumer = registry.mount({ label: 'consumer', requires: [key], provides: [], setup: context => { context.require(key) } })
  await registry.whenQuiescent()
  registry.scope.on(event, 'listener', () => {})
  registry.scope.intercept(middleware, 'handler', async (_request, next) => await next())
  try {
    await registry.scope.emit(event, undefined)
    await registry.scope.invoke(middleware, undefined, () => 'terminal')
    await registry.dispose()
    assert.equal(provider.status, 'disposed')
    assert.equal(consumer.status, 'disposed')
    assert.deepEqual(registry.snapshot().providers, [])
    assert.equal(cleaned, 1)
  } finally {
    await registry.dispose()
    await Promise.allSettled([provider.dispose(), consumer.dispose()])
  }
})

test('built disposal completes resource retirement despite a small activation budget', async () => {
  const registry = new CapabilityRegistry({ maxReconciliationSteps: 1 }), cleaned = []
  const handles = Array.from({ length: 3 }, (_, index) => registry.mount({ label: `resource ${index}`, requires: [], provides: [],
    setup: context => context.apply('resource', () => index, value => { cleaned.push(value) }).then(() => undefined),
  }))
  try {
    await assert.rejects(registry.whenQuiescent(), { code: 'REGISTRY_NOT_CONVERGED', reason: 'step-limit' })
    for (let pass = 0; pass < 4; pass++) await registry.whenQuiescent().catch(() => undefined)
    assert.equal(handles.every(handle => handle.status === 'active'), true)
    await registry.dispose()
    assert.deepEqual(cleaned, [2, 1, 0])
    assert.equal(handles.every(handle => handle.status === 'disposed'), true)
    await assert.rejects(handles[2].retry(), { code: 'COMPONENT_INACTIVE', state: 'disposed' })
  } finally {
    await registry.dispose()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }
})

test('built terminal Handles and expired Contexts retire private resource references', async () => {
  class Resource {}
  const registry = new CapabilityRegistry(), key = createCapabilityKey('built-retired-resource')
  let expired
  function mount() {
    const value = new Resource()
    return registry.mount({ label: 'resource factory', requires: [], provides: [key], setup: context => context.provide(key, value) })
  }
  assert.equal(queryObjects(Resource, { format: 'count' }), 0)
  try {
    const handle = mount()
    registry.mount({ label: 'context consumer', requires: [key], provides: [], setup: context => {
      expired = context
      context.require(key)
    } })
    await registry.whenQuiescent()
    await handle.dispose()
    await setImmediate()
    assert.equal(queryObjects(Resource, { format: 'count' }), 0)
    assert.equal(handle.status, 'disposed')
    assert.throws(() => expired.require(key), { code: 'COMPONENT_INACTIVE', state: 'settled' })
    assert.equal(registry.status, 'accepting')
  } finally { await registry.dispose() }
})

test('built failure snapshots isolate JSON details and causes from raw errors', async () => {
  const registry = new CapabilityRegistry(), reason = { message: 'ordinary JSON failure' }
  const handle = registry.mount({ label: 'failure projection', requires: [], provides: [], setup: () => { throw reason } })
  try {
    await registry.whenQuiescent()
    const snapshot = registry.snapshot()
    snapshot.components[0].failure.details.rollbackAttempted = 99
    snapshot.components[0].failure.cause.message = 'caller changed projection'
    assert.equal(handle.error.reason, reason)
    assert.equal(handle.error.details.rollbackAttempted, 0)
    assert.equal(reason.message, 'ordinary JSON failure')
    assert.equal(registry.snapshot().components[0].failure.cause.message, reason.message)
  } finally { await registry.dispose() }
})

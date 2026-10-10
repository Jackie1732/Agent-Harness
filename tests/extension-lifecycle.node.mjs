import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { queryObjects } from 'node:v8'
import { CapabilityRegistry, createEventName, createMiddlewareName } from '../dist/index.js'

test('built cancellation observers see a closed subtree and its shared disposal task', async () => {
  const registry = new CapabilityRegistry()
  const parent = registry.scope.derive('parent'), child = parent.derive('child')
  const event = createEventName('built-cancel-handoff')
  const registration = child.on(event, 'child listener', () => {})
  let observed, nested, barrier
  parent.signal.addEventListener('abort', () => {
    observed = [parent.status, child.status, registration.status]
    nested = parent.dispose()
    barrier = parent.whenQuiescent()
  }, { once: true })
  try {
    const disposal = parent.dispose()
    assert.deepEqual(observed, ['disposing', 'disposing', 'disposed'])
    assert.equal(nested, disposal)
    assert.throws(() => child.emit(event, undefined), { code: 'SCOPE_INACTIVE' })
    await disposal
    assert.equal((await barrier).status, 'disposed')
  } finally { await registry.dispose(); await nested; await barrier }
})

test('built Registry and Component publish release tasks before cancellation callbacks', async () => {
  const registry = new CapabilityRegistry()
  let componentTask, rootTask, status, cleaned = 0
  const component = registry.mount({ label: 'built-cancel-component', requires: [], provides: [], setup: async context => {
    context.signal.addEventListener('abort', () => { componentTask = component.dispose() }, { once: true })
    await context.apply('resource', () => undefined, () => { cleaned++ })
  } })
  try {
    await registry.whenQuiescent()
    const release = component.dispose()
    assert.equal(componentTask, release)
    await release
    registry.scope.signal.addEventListener('abort', () => {
      status = registry.status
      rootTask = registry.dispose()
    }, { once: true })
    const disposal = registry.dispose()
    assert.equal(status, 'disposing')
    assert.equal(rootTask, disposal)
    await disposal
    assert.equal(cleaned, 1)
  } finally { await registry.dispose(); await componentTask; await rootTask }
})

for (const target of ['origin', 'handler']) {
  test(`built external next retains its original ${target} wait token`, async () => {
    const registry = new CapabilityRegistry()
    const origin = registry.scope.derive('origin'), handler = registry.scope.derive('handler')
    const name = createMiddlewareName(`built-external-next-${target}`)
    const result = Promise.withResolvers(), rescue = Promise.withResolvers()
    let next, outcome, continuation
    handler.intercept(name, 'pending handler', (_request, delegate) => {
      next = delegate
      return result.promise
    })
    const invocation = origin.invoke(name, undefined, async () => {
      const waiting = (target === 'origin' ? origin : handler).whenQuiescent().then(
        () => { outcome = 'fulfilled' },
        reason => { outcome = reason.code },
      )
      await Promise.race([waiting, rescue.promise])
      return 'terminal'
    })
    try {
      continuation = next()
      void continuation.then(result.resolve, result.reject)
      await setImmediate()
      assert.equal(outcome, 'SCOPE_REENTRANT_WAIT')
      assert.equal(await invocation, 'terminal')
    } finally {
      rescue.resolve()
      result.resolve('rescued')
      await Promise.allSettled([invocation, continuation])
      await registry.dispose()
    }
  })
}

test('built synchronous handler closes next before its queued continuation', async () => {
  const registry = new CapabilityRegistry()
  const name = createMiddlewareName('built-synchronous-next')
  const queued = Promise.withResolvers()
  let terminalCalls = 0
  registry.scope.intercept(name, 'sync handler', (_request, next) => {
    queueMicrotask(() => { void next().then(queued.resolve, queued.resolve) })
    return 'outer'
  })
  try {
    assert.equal(await registry.scope.invoke(name, undefined, () => { terminalCalls++; return 'terminal' }), 'outer')
    assert.equal((await queued.promise).code, 'MIDDLEWARE_NEXT_INACTIVE')
    assert.equal(terminalCalls, 0)
  } finally { await registry.dispose() }
})

test('built public Scope facades expose no mutable runtime controls', async () => {
  const registry = new CapabilityRegistry(), child = registry.scope.derive('private child')
  try {
    assert.deepEqual(Reflect.ownKeys(registry.scope), [])
    assert.deepEqual(Reflect.ownKeys(child), [])
    assert.equal('dispose' in registry.scope, false)
    assert.equal(registry.scope.status, 'accepting')
    await child.dispose()
    assert.equal(child.snapshot().status, 'disposed')
  } finally { await registry.dispose() }
})

test('built terminal registration handles retire captured resources in an accepting tree', async () => {
  class Resource {}
  const registry = new CapabilityRegistry(), handles = []
  const event = createEventName('built-retired-event'), middleware = createMiddlewareName('built-retired-middleware')
  function register() {
    const value = new Resource()
    handles.push(registry.scope.on(event, 'listener', () => { void value }))
    handles.push(registry.scope.intercept(middleware, 'handler', () => value))
  }
  assert.equal(queryObjects(Resource, { format: 'count' }), 0)
  try {
    for (let index = 0; index < 20; index++) {
      register()
      await Promise.all(handles.slice(-2).map(handle => handle.dispose()))
    }
    await setImmediate()
    assert.equal(queryObjects(Resource, { format: 'count' }), 0)
    assert.equal(registry.scope.status, 'accepting')
    assert.equal(handles.length, 40)
    assert.deepEqual(registry.scope.snapshot().scopes[0].registrations, [])
    for (const handle of handles) {
      assert.equal(handle.status, 'disposed')
      assert.equal(handle.dispose(), handle.dispose())
      await handle.dispose()
    }
  } finally { await registry.dispose() }
})

for (const called of [false, true]) {
  test(`built saved next retires its original request (called=${called})`, async () => {
    class Request { value = 'request' }
    async function invoke() {
      const registry = new CapabilityRegistry(), name = createMiddlewareName('built-next-retirement')
      let saved
      registry.scope.intercept(name, 'saved next', (request, next) => {
        saved = next
        return called ? next(request) : 'outer'
      })
      try { await registry.scope.invoke(name, new Request(), request => request.value) }
      finally { await registry.dispose() }
      return saved
    }
    const next = await invoke()
    await setImmediate()
    assert.equal(queryObjects(Request, { format: 'count' }), 0)
    await assert.rejects(next(), { code: called ? 'MIDDLEWARE_NEXT_REPEATED' : 'MIDDLEWARE_NEXT_INACTIVE' })
  })
}

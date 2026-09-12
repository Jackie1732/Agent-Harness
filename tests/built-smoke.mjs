import assert from 'node:assert/strict'

const harness = await import('../dist/index.js')

assert.equal(harness.HARNESS_VERSION, '0.0.0')
assert.equal(typeof harness.assertJsonValue, 'function')
assert.equal(typeof harness.HarnessError, 'function')
assert.equal(typeof harness.systemClock.now, 'function')
assert.equal(typeof harness.EffectOwner, 'function')
assert.equal('evaluate' in harness, false)
assert.equal('detectCycles' in harness, false)
assert.equal('capabilityKeyName' in harness, false)
assert.equal('CapabilityUnsatisfiedError' in harness, false)
assert.equal('assertQuiescentStop' in harness, false)
assert.equal('ScopeTree' in harness, false)
assert.equal('eventPayload' in harness, false)
assert.equal('middlewareTypes' in harness, false)

// The Step 1 lifecycle kernel must be usable from the built output alone.
const trace = []
const owner = new harness.EffectOwner('built-smoke')
const lease = await owner.run('effect', async effect => {
  return await effect.apply('op', () => 'value', value => {
    trace.push(value)
  })
})
assert.equal(lease.value, 'value')
await lease.dispose()
await owner.dispose()
assert.deepEqual(trace, ['value'])
assert.equal(owner.status, 'disposed')

// The Step 2 capability layer must work from the built output alone.
const capability = harness.createCapabilityKey('smoke.capability')
const registry = new harness.CapabilityRegistry()
const consumed = []
registry.mount({
  label: 'provider',
  requires: [],
  provides: [capability],
  setup: context => {
    context.provide(capability, 'bound')
  },
})
const consumer = registry.mount({
  label: 'consumer',
  requires: [capability],
  provides: [],
  setup: context => {
    consumed.push(context.require(capability))
  },
})
await registry.whenQuiescent()
assert.equal(consumer.status, 'active')
assert.deepEqual(consumed, ['bound'])

// The Step 3 extension layer must expose only its application-facing names and scopes.
const event = harness.createEventName('smoke.event')
const middleware = harness.createMiddlewareName('smoke.middleware')
const received = []
registry.scope.on(event, 'listener', value => {
  received.push(value)
})
registry.scope.intercept(middleware, 'handler', async (request, next) => {
  return `${request}:${await next()}`
})
await registry.scope.emit(event, 3)
assert.deepEqual(received, [3])
assert.equal(
  await registry.scope.invoke(middleware, 'outer', () => 'terminal'),
  'outer:terminal',
)
assert.equal('dispose' in registry.scope, false)
await registry.dispose()
assert.equal(registry.status, 'disposed')
assert.equal(registry.snapshot().providers.length, 0)

console.log('built-smoke: dist/index.js loaded with plain Node')

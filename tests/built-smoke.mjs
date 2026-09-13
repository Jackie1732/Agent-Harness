import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
for (const internalName of [
  'ScopeTree',
  'RegistrationStore',
  'TaskTracker',
  'collectSubtree',
  'emitEvent',
  'invokeMiddleware',
  'isWithin',
  'FrameScanner',
  'SerialGate',
  'SessionHandleImpl',
  'loadSessionHistory',
  'scanFileSessionEvents',
  'createFileSessionBackendForTest',
]) {
  assert.equal(internalName in harness, false, `${internalName} must stay internal`)
}
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

// The Step 4 Session layer must commit and project through the built entry alone.
const sessionId = harness.parseSessionId('00000000-0000-4000-8000-000000000099')
const recorded = harness.createDurableEventDefinition({
  type: 'smoke/recorded',
  payloadVersion: 1,
  ignorable: false,
  decode: value => value,
})
const sessionRoot = await mkdtemp(join(tmpdir(), 'atomic-harness-built-'))
try {
const sessionRepository = new harness.SessionRepository({
  backend: new harness.FileSessionBackend({ root: sessionRoot, maxRecordBytes: 2048 }),
  catalog: harness.createDurableEventCatalog([recorded]),
  maxLineageDepth: 2,
  identitySource: { nextSessionId: () => sessionId },
  clock: { now: () => 1_789_257_600_000 },
})
const session = await sessionRepository.create()
await session.append(recorded, { value: 4 })
await sessionRepository.dispose()
const reopenedRepository = new harness.SessionRepository({
  backend: new harness.FileSessionBackend({ root: sessionRoot, maxRecordBytes: 2048 }),
  catalog: harness.createDurableEventCatalog([recorded]),
  maxLineageDepth: 2,
})
const reopened = await reopenedRepository.open(sessionId)
const projected = reopened.project({
  name: 'smoke count',
  initial: () => 0,
  apply: state => state + 1,
})
assert.equal(projected.state, 1)
assert.equal(projected.coverage.length, 1)
assert.equal(reopened.snapshot().localPosition, 1)
await reopenedRepository.dispose()
} finally {
  await rm(sessionRoot, { recursive: true, force: true })
}

console.log('built-smoke: dist/index.js loaded with plain Node')

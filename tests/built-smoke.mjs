import assert from 'node:assert/strict'

const harness = await import('../dist/index.js')

assert.equal(harness.HARNESS_VERSION, '0.0.0')
assert.equal(typeof harness.assertJsonValue, 'function')
assert.equal(typeof harness.HarnessError, 'function')
assert.equal(typeof harness.systemClock.now, 'function')
assert.equal(typeof harness.EffectOwner, 'function')

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

console.log('built-smoke: dist/index.js loaded with plain Node')

import assert from 'node:assert/strict'

const harness = await import('../dist/index.js')

assert.equal(harness.HARNESS_VERSION, '0.0.0')
assert.equal(typeof harness.assertJsonValue, 'function')
assert.equal(typeof harness.HarnessError, 'function')
assert.equal(typeof harness.systemClock.now, 'function')

console.log('built-smoke: dist/index.js loaded with plain Node')

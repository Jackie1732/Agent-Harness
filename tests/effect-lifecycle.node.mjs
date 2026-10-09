import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { queryObjects } from 'node:v8'
import { EffectOwner } from '../dist/index.js'

test('released resources leave a long-lived Owner through the built public API', async () => {
  class Resource { closed = false }
  const owner = new EffectOwner('built-repeated-observer')
  assert.equal(queryObjects(Resource, { format: 'count' }), 0)
  try {
    for (let generation = 0; generation < 20; generation++) {
      const lease = await owner.run('observer', async effect => {
        await effect.apply('resource', () => new Resource(), value => { value.closed = true })
      })
      await lease.dispose()
    }
    await setImmediate()
    assert.equal(queryObjects(Resource, { format: 'count' }), 0)
    assert.equal(owner.status, 'accepting')
  } finally {
    await owner.dispose()
  }
})

test('failed startup aborts before joining its worker through the built public API', async () => {
  const owner = new EffectOwner('built-failed-worker')
  const signal = Promise.withResolvers()
  const stopped = Promise.withResolvers()
  const joining = Promise.withResolvers()
  const reason = new Error('setup failed')
  const trace = []
  const result = owner.run('worker', async effect => {
    signal.resolve(effect.signal)
    effect.signal.addEventListener('abort', () => {
      trace.push('abort')
      stopped.resolve()
    }, { once: true })
    await effect.apply('worker', () => ({ join: () => stopped.promise }), async worker => {
      trace.push('join')
      joining.resolve()
      await worker.join()
      trace.push('joined')
    })
    throw reason
  }).then(value => ({ value }), error => ({ error }))
  try {
    await joining.promise
    assert.equal((await signal.promise).aborted, true)
    assert.equal((await result).error, reason)
    assert.deepEqual(trace, ['abort', 'join', 'joined'])
    assert.equal(owner.status, 'accepting')
  } finally {
    await owner.dispose()
    await result
  }
})

test('admitted acquisition starts before synchronous release through the built public API', async () => {
  const owner = new EffectOwner('built-start-before-release')
  const entered = Promise.withResolvers()
  const acquired = Promise.withResolvers()
  const trace = []
  const result = owner.run('resource', effect => {
    void effect.apply('acquire', () => {
      trace.push(effect.signal.aborted ? 'started-aborted' : 'started')
      entered.resolve()
      return acquired.promise
    }, value => { trace.push('reverted:' + value) }).catch(() => undefined)
    owner.dispose().catch(() => undefined)
    trace.push('release-requested')
    return 'setup'
  }).then(value => ({ value }), error => ({ error }))
  try {
    await entered.promise
    assert.deepEqual([...trace], ['started', 'release-requested'])
    acquired.resolve('resource')
    assert.equal((await result).error.code, 'EFFECT_START_INTERRUPTED')
    await owner.dispose()
    assert.deepEqual(trace, ['started', 'release-requested', 'reverted:resource'])
    assert.equal(owner.status, 'disposed')
  } finally {
    acquired.resolve('resource')
    await owner.dispose()
    await result
  }
})

test('an older inverse joins a completed newer Lease through the built public API', async () => {
  const owner = new EffectOwner('built-completed-sibling')
  const trace = []
  let newer
  try {
    await owner.run('older', effect => effect.apply('older-resource', () => 'older', async value => {
      trace.push(value)
      await newer.dispose()
      trace.push('newer-joined')
    }))
    newer = await owner.run('newer', effect => effect.apply('newer-resource', () => 'newer', value => {
      trace.push(value)
    }))
    await owner.dispose()
    assert.deepEqual(trace, ['newer', 'older', 'newer-joined'])
    const first = newer.dispose()
    assert.equal(newer.dispose(), first)
    await first
    assert.deepEqual(trace, ['newer', 'older', 'newer-joined'])
  } finally {
    await owner.dispose().catch(() => undefined)
  }
})

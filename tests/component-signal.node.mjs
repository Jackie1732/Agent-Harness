import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { CapabilityRegistry, createEventName } from '../dist/index.js'

for (const mode of ['component', 'registry']) {
  test(`built ${mode} release cancels an activation before joining its Scope frame`, async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName(`built-signal-${mode}`)
    const entered = Promise.withResolvers(), cancelled = Promise.withResolvers(), finish = Promise.withResolvers()
    let signal, scope, live = false, releases = 0
    const component = registry.mount({ label: mode, requires: [], provides: [], setup: async context => {
      signal = context.signal; scope = context.scope
      signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
      await context.apply('resource', () => { live = true }, () => { live = false; releases++ })
      scope.on(event, 'cooperative-frame', async () => {
        entered.resolve()
        await cancelled.promise
        assert.equal(live, true)
        await finish.promise
        assert.equal(live, true)
      })
    } })
    await registry.whenQuiescent()
    const emission = registry.scope.emit(event, undefined)
    await entered.promise
    const closing = mode === 'component' ? component.dispose() : registry.dispose()
    try {
      await setImmediate()
      assert.equal(signal.aborted, true)
      assert.equal(scope.status, 'disposing')
      assert.equal(live, true)
      assert.equal(releases, 0)
      finish.resolve()
      await emission
      await closing
      assert.equal(live, false)
      assert.equal(releases, 1)
    } finally {
      cancelled.resolve(); finish.resolve()
      await Promise.allSettled([emission, closing])
      await registry.dispose()
    }
  })
}

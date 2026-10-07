import { expect, it } from 'vitest'
import { observeFinite } from '../../src/host/finite-observer.js'
import type { HostTimer } from '../../src/host/timer.js'

function observerTimer() {
  let now = 0
  const pending = new Set<() => void>()
  const timer: HostTimer = { now: () => now, wait: (ms, signal) => new Promise(resolve => {
    const done = () => { pending.delete(done); signal.removeEventListener('abort', done); resolve() }
    pending.add(done); signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
    else now += ms
  }) }
  return { timer, pending, flush: () => { for (const done of [...pending]) done() } }
}

it('checks caller Abort before the initial read and joins a Host stop using its last certified observation', async () => {
  const time = observerTimer(), stop = new AbortController(), caller = new AbortController()
  let reads = 0
  const owner = { stopSignal: stop.signal, trackObservation: <T>(task: () => Promise<T>) => Promise.resolve().then(task) }
  const read = () => ({ recoveryRequired: false, count: ++reads })
  caller.abort(new Error('caller-stopped'))
  expect(() => observeFinite(owner, time.timer, read, () => false, { timeoutMs: 10, scanIntervalMs: 5, signal: caller.signal })).toThrow('caller-stopped')
  expect(reads).toBe(0)
  const observing = observeFinite(owner, time.timer, read, () => false, { timeoutMs: 10, scanIntervalMs: 5 })
  await Promise.resolve()
  expect(reads).toBe(1)
  expect(time.pending.size).toBe(1)
  stop.abort()
  expect(await observing).toEqual({ status: 'host-closed', observation: { recoveryRequired: false, count: 1 } })
  expect(reads).toBe(1)
  expect(time.pending.size).toBe(0)
})

it('performs a final deadline scan and allows an observed condition before recovery diagnostics', async () => {
  const time = observerTimer(), stop = new AbortController()
  let complete = false, reads = 0
  const owner = { stopSignal: stop.signal, trackObservation: <T>(task: () => Promise<T>) => Promise.resolve().then(task) }
  const observing = observeFinite(owner, time.timer, () => ({ recoveryRequired: complete, complete, count: ++reads }), value => value.complete,
    { timeoutMs: 5, scanIntervalMs: 5 })
  await Promise.resolve()
  complete = true; time.flush()
  expect(await observing).toEqual({ status: 'condition-met', observation: { complete: true, recoveryRequired: true, count: 2 } })
  expect(time.pending.size).toBe(0)
})

it('returns timeout after its final scan and rejects an actual recovery block without scheduling a timer', async () => {
  const time = observerTimer(), stop = new AbortController()
  const owner = { stopSignal: stop.signal, trackObservation: <T>(task: () => Promise<T>) => Promise.resolve().then(task) }
  const observing = observeFinite(owner, time.timer, () => ({ recoveryRequired: false }), () => false, { timeoutMs: 5, scanIntervalMs: 5 })
  await Promise.resolve(); time.flush()
  expect((await observing).status).toBe('timeout')
  await expect(observeFinite(owner, time.timer, () => ({ recoveryRequired: true }), () => false, { timeoutMs: 5, scanIntervalMs: 5 })).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
  expect(time.pending.size).toBe(0)
})

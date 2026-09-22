import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { decodeHostConfig, initializeHost, openHost, resolveHostConfig, ScriptedModelProvider } from '../../src/index.js'
import type { HostTimer, ModelFrame } from '../../src/index.js'
import { SessionMailboxImpl } from '../../src/communication/mailbox.js'
import { HostObservations } from '../../src/host/observation.js'
import { hostConfig, twoMemberHostConfig } from './fixtures.js'

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

it.each(['mailbox-close', 'statistics-error'])('joins a sibling model during delivery %s', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'host-delivery-join-'))
  const config = twoMemberHostConfig(root)
  const spec = resolveHostConfig(decodeHostConfig({ ...config,
    scheduling: { ...(config.scheduling as object), maxSlotsPerScan: 2, maxBatchesPerRun: 2 } }, root))
  await initializeHost(spec)
  const delivered = gate(); const commit = gate(); const started = gate(); const release = gate()
  let failStatistics = false
  const statisticsError = new Error('statistics failed')
  const original = SessionMailboxImpl.prototype.completeAttempt
  const spy = vi.spyOn(SessionMailboxImpl.prototype, 'completeAttempt').mockImplementation(async function (this: SessionMailboxImpl, ...args) {
    delivered.resolve(); await commit.promise
    return await original.apply(this, args)
  })
  const host = await openHost(spec, { timer: { now() { if (failStatistics) throw statisticsError; return performance.now() },
    wait: (_ms, signal) => new Promise(resolve => {
      const done = () => { signal.removeEventListener('abort', done); resolve() }
      signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done()
    }) }, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    script: async function* (): AsyncGenerator<ModelFrame> { started.resolve(); await release.promise; yield { kind: 'complete', stopReason: 'stop' } },
  }) } })
  let running: ReturnType<typeof host.run> | undefined
  try {
    await host.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"message"}' })
    await host.submitTask('reviewer', 'hold business')
    running = host.run(); let settled = false
    void running.then(() => { settled = true }, () => { settled = true })
    await Promise.all([delivered.promise, started.promise])
    const offline = host.setMailboxOnline('writer', false, 'cancel')
    await turn(); failStatistics = kind === 'statistics-error'; commit.resolve(); await offline; await turn()
    expect(settled).toBe(false)
    expect(() => host.run()).toThrow(expect.objectContaining({ code: 'HOST_BUSY' }))
    release.resolve()
    if (kind === 'statistics-error') await expect(running).rejects.toBe(statisticsError)
    else expect(await running).toMatchObject({ businessRuns: 1, deliveryAttempts: 1 })
  } finally {
    failStatistics = false; commit.resolve(); release.resolve(); await running?.catch(() => undefined)
    spy.mockRestore(); await host.shutdown()
  }
})

it.each(['observation', 'clock', 'timer'] as const)('cancels and joins accepted work after %s failure, including shutdown upgrade', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'host-scheduler-failure-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(root), root))
  await initializeHost(spec)
  const started = gate(); const aborted = gate(); const release = gate()
  const failure = new Error(`injected ${kind} failure`)
  let fail = false
  const wakes = new Set<() => void>()
  const timer: HostTimer = { now: () => 0, wait: (_ms, signal) => {
    if (fail && kind === 'timer') return Promise.reject(failure)
    return new Promise(resolve => {
      const done = () => { wakes.delete(done); signal.removeEventListener('abort', done); resolve() }
      wakes.add(done); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done()
    })
  } }
  const read = HostObservations.prototype.read
  const spy = vi.spyOn(HostObservations.prototype, 'read').mockImplementation(function (this: HostObservations, ...args) {
    if (fail && kind === 'observation') throw failure
    return read.apply(this, args)
  })
  const host = await openHost(spec, { timer, clock: { now() { if (fail && kind === 'clock') throw failure; return Date.now() } },
    bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (_submission, signal): AsyncGenerator<ModelFrame> {
        signal.addEventListener('abort', aborted.resolve, { once: true }); started.resolve(); await release.promise
      },
    }) } })
  await host.submitTask('writer', 'wait for real settlement')
  const running = host.run(); let settled = false
  const result = running.then(value => { settled = true; return value }, error => { settled = true; return error })
  try {
    await started.promise; fail = true
    for (const wake of [...wakes]) wake()
    await aborted.promise
    expect(settled).toBe(false)
    expect(() => host.run()).toThrow(expect.objectContaining({ code: 'HOST_BUSY' }))
    fail = false
    const stopping = host.shutdown({ mode: 'drain' })
    expect(host.shutdown({ mode: 'cancel' })).toBe(stopping)
    expect(host.status).toBe('stopping')
    release.resolve()
    expect(await result).toBe(failure)
    await stopping
    expect(host.status).toBe('stopped')
  } finally { fail = false; release.resolve(); for (const wake of [...wakes]) wake(); await result; spy.mockRestore(); await host.shutdown() }
})

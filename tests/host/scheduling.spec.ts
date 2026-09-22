import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AsyncResource } from 'node:async_hooks'
import { decodeHostConfig, initializeHost, openHost, resolveHostConfig, ScriptedModelProvider } from '../../src/index.js'
import type { AtomicHost, HostTimer, ModelFrame } from '../../src/index.js'
import { hostConfig, twoMemberHostConfig } from './fixtures.js'
import { hostExitCode } from '../../src/host/cli-interactive.js'

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

it('wakes an idle service on durable input without waiting for its fallback scan interval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-input-wake-'))
  const config = hostConfig(root)
  const spec = resolveHostConfig(decodeHostConfig({ ...config, scheduling: { ...(config.scheduling as object), scanIntervalMs: 60_000 } }, root))
  await initializeHost(spec)
  const waiting = gate(); const prepared = gate()
  const timer: HostTimer = { now: () => 0, wait: (_milliseconds, signal) => new Promise(resolve => {
    const done = () => { signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done()
    waiting.resolve()
  }) }
  const host = await openHost(spec, { timer, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    onPrepare: prepared.resolve, script: async function* (): AsyncGenerator<ModelFrame> { yield { kind: 'complete', stopReason: 'stop' } },
  }) } })
  const serving = host.serve()
  try {
    await waiting.promise
    await host.submitTask('writer', 'wake now')
    await prepared.promise
  } finally { await host.shutdown(); await serving }
})

it('reports exhausted roots under truncation and gives their unresolved review the higher exit priority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-root-budget-'))
  const config = hostConfig(root)
  const member = (config.members as readonly Record<string, unknown>[])[0]!
  const spec = resolveHostConfig(decodeHostConfig({ ...config, members: [{ ...member, spec: { ...(member.spec as object),
    budget: { ...((member.spec as Record<string, object>).budget), models: 0 },
    limits: { ...((member.spec as Record<string, object>).limits), maxReportEntries: 0 },
  } }] }, root))
  await initializeHost(spec)
  const host = await openHost(spec)
  try {
    await host.submitTask('writer', 'no model budget')
    const report = await host.run()
    expect(report.members[0]!.agent.roots).toHaveLength(0)
    expect(report.counts.exhaustedRoots).toBe(1)
    expect(report.counts.reviewRequiredInputs).toBe(1)
    expect(hostExitCode(report)).toBe(11)
    report.members[0]!.agent.counts.exhaustedRoots = 0
    expect(host.report().counts.exhaustedRoots).toBe(1)
  } finally { await host.shutdown() }
})

it.each([1, 2])('rotates business admission with scan size %i and a truncated report', async maxSlotsPerScan => {
  const root = await mkdtemp(join(tmpdir(), 'host-fairness-'))
  const config = twoMemberHostConfig(root)
  const members = (config.members as readonly Record<string, unknown>[]).map(member => ({ ...member,
    spec: { ...(member.spec as object), limits: { ...((member.spec as Record<string, object>).limits), maxTurnsPerRun: 1 } } }))
  const spec = resolveHostConfig(decodeHostConfig({ ...config, members,
    scheduling: { ...(config.scheduling as object), maxSlotsPerScan, maxBatchesPerRun: 1, maxReportEntries: 1 } }, root))
  await initializeHost(spec)
  const host = await openHost(spec)
  try {
    await host.submitTask('writer', 'first'); await host.submitTask('writer', 'second')
    await host.submitTask('reviewer', 'review')
    expect(host.report()).toMatchObject({ truncated: true, counts: { members: 2, runnableInputs: 3 } })
    expect(await host.run()).toMatchObject({ batches: 1, businessRuns: 1, counts: { pendingInputs: 2 } })
    expect(await host.run()).toMatchObject({ batches: 1, businessRuns: 1, counts: { pendingInputs: 1 } })
    expect(host.report().members[0]!.agent.counts.roots).toBe(1)
  } finally { await host.shutdown() }
})

it('expires a root while its model stream is still waiting, using the injected timer and clock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-deadline-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(root), root))
  let now = Date.parse('2026-09-19T00:00:00.000Z')
  const started = gate(); const aborted = gate()
  const wakes = new Set<() => void>()
  const timer: HostTimer = { now: () => now, wait: (_milliseconds, signal) => new Promise(resolve => {
    const done = () => { wakes.delete(done); signal.removeEventListener('abort', done); resolve() }
    wakes.add(done); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done()
  }) }
  await initializeHost(spec, { clock: { now: () => now } })
  const host = await openHost(spec, { clock: { now: () => now }, timer, bindings: {
    createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (_submission, signal): AsyncGenerator<ModelFrame> {
        started.resolve()
        await new Promise<void>(resolve => { signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true }); if (signal.aborted) resolve() })
      },
    }),
  } })
  try {
    await host.submitTask('writer', 'hang until deadline')
    const running = host.run()
    await started.promise
    now += 60_001
    for (const wake of [...wakes]) wake()
    await aborted.promise
    const report = await running
    expect(report.members[0]!.agent.roots[0]).toMatchObject({ outcome: 'timed-out' })
    expect(report.counts.reviewRequiredInputs).toBe(1)
  } finally { await host.shutdown() }
})

it('drain can upgrade to cancel while retaining the same settlement task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-drain-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(root), root))
  const started = gate(); const released = gate(); const aborted = gate()
  await initializeHost(spec)
  const host = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    script: async function* (_submission, signal): AsyncGenerator<ModelFrame> {
      signal.addEventListener('abort', aborted.resolve, { once: true }); started.resolve(); await released.promise
    },
  }) } })
  await host.submitTask('writer', 'wait')
  const running = host.run(); await started.promise
  const drain = host.shutdown({ mode: 'drain' })
  expect(host.status).toBe('stopping')
  expect(host.shutdown({ mode: 'cancel' })).toBe(drain)
  await aborted.promise
  expect(await readFile(join(root, '.atomic-harness.lock'), 'utf8')).toContain('token')
  released.resolve(); await running; await drain
  expect(host.status).toBe('stopped')
})

it('requests shutdown before rejecting a Provider callback waiting for its own Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-reentry-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(root), root))
  await initializeHost(spec)
  let host: AtomicHost
  let rejection: unknown
  host = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    onPrepare() { try { host.shutdown() } catch (cause) { rejection = cause } },
    script: async function* (): AsyncGenerator<ModelFrame> { yield { kind: 'complete', stopReason: 'stop' } },
  }) } })
  await host.submitTask('writer', 'reenter')
  await host.run()
  expect(rejection).toMatchObject({ code: 'HOST_REENTRANT_WAIT' })
  await host.shutdown()
  expect(host.status).toBe('stopped')
})

it('rejects cleanup self-waits but accepts callbacks carrying an already-settled task token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-stale-token-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(root), root))
  await initializeHost(spec)
  let host: AtomicHost
  let inherited: (() => Promise<void>) | undefined
  let cleanupReentry: unknown
  host = await openHost(spec, { bindings: { createModelProvider: member => {
    const provider = new ScriptedModelProvider({ ...member.model,
      onPrepare() { inherited = AsyncResource.bind(() => host.shutdown()) },
      script: async function* (): AsyncGenerator<ModelFrame> { yield { kind: 'complete', stopReason: 'stop' } },
    })
    return { descriptor: provider.descriptor, prepare: request => provider.prepare(request), dispose: async () => {
      try { host.shutdown() } catch (cause) { cleanupReentry = cause }
      await provider.dispose()
    } }
  } } })
  await host.submitTask('writer', 'task')
  await host.run()
  await inherited!()
  expect(cleanupReentry).toMatchObject({ code: 'HOST_REENTRANT_WAIT' })
  expect(host.status).toBe('stopped')
})

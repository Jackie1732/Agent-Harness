import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { runExperiment } from '../../src/experiment/runner.js'
import { readExperimentStorage } from '../../src/experiment/storage.js'
import { closeInterruptedExperiment } from '../../src/experiment/administration.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { textFrames } from '../model/fixtures.js'
import { experimentDefinition } from './definition-fixture.js'
import type { RunExperimentOptions } from '../../src/experiment/runner-types.js'
import * as initialization from '../../src/host/initialization.js'
import * as hostRuntime from '../../src/host/runtime.js'
import { collectExperimentEvidence } from '../../src/experiment/evidence.js'
import { projectAgentSession } from '../../src/agent/projection.js'

const roots: string[] = []
async function directory() { const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-lifecycle-')); roots.push(root); return root }
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function callbacks(root: string): JsonObject {
  const base = experimentDefinition(root)
  return { ...base, repetitions: 1, variants: (base.variants as readonly JsonObject[]).map(variant => ({ ...variant,
    fixture: { kind: 'programmatic', fixtureKey: 'callbacks', version: '1', sourceSha256: 'a'.repeat(64) } })) }
}

function loseAcknowledgement(type: string) {
  const original = FileSessionBackend.prototype.openWriter
  return vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id, validateCommitted) {
    const writer = await original.call(this, id, validateCommitted)
    return { ...writer, append: async (position, event) => {
      const result = await writer.append(position, event)
      if (event.type === type) throw new Error('committed but acknowledgement lost')
      return result
    } }
  })
}

describe('experiment emission and interruption lifecycle', () => {
  it.each(['experiment/unit-started', 'experiment/unit-sealed', 'experiment/finalized'])('stops on %s lost acknowledgement and reopens only the actual file prefix', async type => {
    const root = await directory(), plan = await planExperiment(callbacks(root))
    let calls = 0
    const fault = loseAcknowledgement(type)
    const options: RunExperimentOptions = { fixtureBindings: { callbacks: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: () => { calls++; return textFrames('42') } }) } } }
    await expect(runExperiment(plan, options)).rejects.toMatchObject({ code: 'EXPERIMENT_COMMIT_UNKNOWN' })
    fault.mockRestore()
    const read = await readExperimentStorage(plan.storage.controlRoot)
    expect(read.kind).toBe('initialized')
    if (type === 'experiment/unit-started') {
      expect(calls).toBe(0)
      expect(read.state!.activeUnit).toBe(plan.units[0]!.unitKey)
      await expect(stat(plan.units[0]!.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(runExperiment(plan, { ...options, continueUnstarted: true })).rejects.toThrow('experiment-cannot-continue')
      await closeInterruptedExperiment(plan.storage.controlRoot, { predecessorStopped: true })
      expect(calls).toBe(0)
    } else if (type === 'experiment/unit-sealed') {
      expect(calls).toBe(1)
      expect(read.state!.units[0]!.sealed?.payload.outcome).toBe('completed')
      expect(read.state!.units[1]!.started).toBeNull()
      const resumed = await runExperiment(plan, { ...options, continueUnstarted: true })
      expect(resumed.finalized).toBe(true)
      expect(calls).toBe(2)
      expect((await readExperimentStorage(plan.storage.controlRoot)).state!.evaluations).toHaveLength(2)
    } else {
      expect(calls).toBe(2)
      expect(read.state!.finalized).not.toBeNull()
      await expect(runExperiment(plan, { ...options, continueUnstarted: true })).rejects.toThrow('experiment-cannot-continue')
      await closeInterruptedExperiment(plan.storage.controlRoot, { predecessorStopped: true })
      expect(calls).toBe(2)
    }
  }, 30_000)

  it('awaits acquired provider release on cancellation and starts no successor unit', async () => {
    const root = await directory(), plan = await planExperiment(callbacks(root)), controller = new AbortController()
    let acquired = 0, released = 0, scripts = 0
    const result = await runExperiment(plan, { signal: controller.signal, fixtureBindings: { callbacks: {
      createModelProvider: member => new ScriptedModelProvider({ ...member.model,
        onAcquire: () => { acquired++; controller.abort() }, onClose: () => { released++ },
        script: () => { scripts++; return textFrames('42') } }),
    } } })
    expect(acquired).toBe(1)
    expect(released).toBe(1)
    expect(scripts).toBe(0)
    expect(result.stoppedBy).toBe('cancelled')
    expect(result.units[0]!.sealed?.payload).toMatchObject({ outcome: 'cancelled', closure: 'confirmed' })
    expect(result.units[1]!.notRun).toBe('cancelled-before-start')
  }, 30_000)

  it('seals a failed fixture with confirmed closure and honors stop policy', async () => {
    const root = await directory(), base = callbacks(root)
    const plan = await planExperiment({ ...base, runPolicy: { ...(base.runPolicy as JsonObject), onCaseFailure: 'stop' } })
    let calls = 0
    const result = await runExperiment(plan, { fixtureBindings: { callbacks: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      onPrepare: () => { calls++; throw new Error('fixture request mismatch') }, script: () => textFrames('42') }) } } })
    expect(calls).toBe(1)
    expect(result.stoppedBy).toBe('policy')
    expect(result.units[0]!.sealed?.payload).toMatchObject({ outcome: 'failed', closure: 'confirmed' })
    expect(result.units[1]!.notRun).toBe('skipped-by-policy')
  }, 30_000)

  it('records known closure after artifact publication fails and does not execute the next unit', async () => {
    const root = await directory(), base = experimentDefinition(root)
    const plan = await planExperiment({ ...base, repetitions: 1, evidenceLimits: { ...(base.evidenceLimits as JsonObject), maxReportBytes: 1 } })
    await expect(runExperiment(plan)).rejects.toMatchObject({ code: 'EXPERIMENT_LIMIT_EXCEEDED' })
    const read = await readExperimentStorage(plan.storage.controlRoot)
    expect(read.state!.units[0]!.unresolved?.payload).toMatchObject({ outcome: 'completed', closure: 'confirmed', reason: 'artifact-publication-failed' })
    expect(read.state!.units[1]!.started).toBeNull()
    await expect(stat(plan.units[1]!.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('preserves an unknown Model result and stops when its failed release prevents confirmed Host closure', async () => {
    const root = await directory(), plan = await planExperiment(callbacks(root))
    let closes = 0
    const result = await runExperiment(plan, { fixtureBindings: { callbacks: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      onClose: () => { closes++; throw new Error('exchange release failed') }, script: () => textFrames('42') }) } } })
    expect(closes).toBe(1)
    expect(result.stoppedBy).toBe('unresolved')
    expect(result.units[0]!.unresolved?.payload).toMatchObject({ outcome: 'result-unknown', closure: 'failed' })
    expect(result.units[1]!.started).toBeNull()
  }, 60_000)

  it('retains completed business evidence when Host resource disposal fails and starts no successor', async () => {
    const root = await directory(), plan = await planExperiment(callbacks(root))
    let providers = 0, released = 0
    const result = await runExperiment(plan, { fixtureBindings: { callbacks: { createModelProvider: member => {
      providers++
      const provider = new ScriptedModelProvider({ ...member.model, script: () => textFrames('42') })
      return { descriptor: provider.descriptor, prepare: request => provider.prepare(request), dispose: async () => {
        await provider.dispose(); released++; throw new Error('provider disposal failed')
      } }
    } } } })
    expect(providers).toBe(1)
    expect(released).toBe(1)
    expect(result.stoppedBy).toBe('unresolved')
    expect(result.units[0]!.unresolved?.payload).toMatchObject({ outcome: 'completed', closure: 'failed' })
    expect(result.units[0]!.unresolved?.payload.evidence).not.toBeNull()
    expect(result.units[1]!.started).toBeNull()
    await expect(stat(plan.units[1]!.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('waits for an admitted acquisition to settle at the soft deadline, then releases it before the next unit', async () => {
    const root = await directory(), base = callbacks(root)
    const plan = await planExperiment({ ...base, runPolicy: { ...(base.runPolicy as JsonObject), maxWallTimeMs: 10_000 } })
    let providers = 0, acquired = 0, released = 0
    const result = await runExperiment(plan, { fixtureBindings: { callbacks: { createModelProvider: member => {
      const ordinal = ++providers
      if (ordinal === 2) expect(released).toBe(1)
      return new ScriptedModelProvider({ ...member.model, onAcquire: async (_submission, signal) => {
        acquired++
        if (ordinal === 1 && !signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      }, onClose: () => { released++ }, script: () => textFrames('42') })
    } } } })
    expect(acquired).toBe(2)
    expect(released).toBe(2)
    expect(result.units[0]!.sealed?.payload).toMatchObject({ outcome: 'timed-out', closure: 'confirmed' })
    expect(result.units[1]!.sealed?.payload).toMatchObject({ outcome: 'completed', closure: 'confirmed' })
  }, 60_000)

  it.each(['initialize', 'open'] as const)('joins an admitted %s operation after its soft deadline and submits no business input', async phase => {
    const root = await directory(), base = callbacks(root)
    const plan = await planExperiment({ ...base, comparisons: [], variants: [(base.variants as readonly JsonObject[])[0]!],
      runPolicy: { ...(base.runPolicy as JsonObject), maxWallTimeMs: 1000 } })
    let opened = 0, disposed = 0, calls = 0
    const initialize = initialization.initializeHost, open = hostRuntime.openHost
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(initialization, 'initializeHost').mockImplementation(async recipe => {
      const result = await initialize(recipe)
      if (phase === 'initialize') await vi.advanceTimersByTimeAsync(1000)
      return result
    })
    vi.spyOn(hostRuntime, 'openHost').mockImplementation(async (recipe, options) => {
      const host = await open(recipe, options)
      opened++
      if (phase === 'open') await vi.advanceTimersByTimeAsync(1000)
      return host
    })
    const result = await runExperiment(plan, { fixtureBindings: { callbacks: { createModelProvider: member => {
      const provider = new ScriptedModelProvider({ ...member.model, script: () => { calls++; return textFrames('42') } })
      return { descriptor: provider.descriptor, prepare: request => provider.prepare(request), dispose: async () => { await provider.dispose(); disposed++ } }
    } } } })
    expect(opened).toBe(phase === 'open' ? 1 : 0)
    expect(disposed).toBe(opened)
    expect(calls).toBe(0)
    expect(result.units[0]!.sealed?.payload).toMatchObject({ outcome: 'timed-out', closure: 'confirmed' })
    const evidence = await collectExperimentEvidence({ recipe: plan.units[0]!.recipe, limits: plan.evidenceLimits, scope: 'unit-local/v1', mode: 'fixture' })
    expect(evidence.evidence.metrics.counts['model.started'].value).toBe(0)
    expect(evidence.snapshots.flatMap(snapshot => projectAgentSession(snapshot).inputs)).toHaveLength(0)
  }, 60_000)
})

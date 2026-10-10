import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { runExperiment } from '../../src/experiment/runner.js'
import { readExperimentStorage } from '../../src/experiment/storage.js'
import { evaluateExperiment, verifyExperiment } from '../../src/experiment/analysis.js'
import { closeInterruptedExperiment } from '../../src/experiment/administration.js'
import { reportExperiment } from '../../src/experiment/report.js'
import * as artifacts from '../../src/experiment/artifacts.js'
import * as environment from '../../src/experiment/environment.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { experimentDefinition } from './definition-fixture.js'

const roots: string[] = []
async function directory() { const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-report-publication-')); roots.push(root); return root }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function interruptReportAppend(committed = false) {
  const original = FileSessionBackend.prototype.openWriter
  return vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id, validateCommitted) {
    const writer = await original.call(this, id, validateCommitted)
    return { ...writer, append: async (position, event) => {
      if (event.type !== 'experiment/report-recorded') return writer.append(position, event)
      if (committed) await writer.append(position, event)
      throw new Error('controller interrupted before report acknowledgement')
    } }
  })
}

async function orphanReport(root: string) {
  const paths = await readdir(join(root, 'reports'))
  expect(paths).toHaveLength(1)
  const path = `reports/${paths[0]!}`
  return { path, bytes: await readFile(join(root, path)) }
}

function useCompiledReportEntry() {
  const observe = environment.experimentControllerEnvironment
  vi.spyOn(environment, 'experimentControllerEnvironment').mockImplementation(entry => observe(entry.replace(/report\.ts$/, 'report.js')))
}

describe('experiment report publication recovery', () => {
  it('continues after an unreferenced report and a declared secondary evaluation without reusing old publication bytes', async () => {
    const root = await directory(), base = experimentDefinition(root), evaluator = (base.evaluators as readonly JsonObject[])[0]!
    const plan = await planExperiment({ ...base, repetitions: 1, evaluators: [evaluator, { ...evaluator, evaluatorKey: 'secondary' }] })
    const fault = interruptReportAppend()
    await expect(runExperiment(plan)).rejects.toMatchObject({ code: 'EXPERIMENT_COMMIT_UNKNOWN' })
    fault.mockRestore()
    const orphan = await orphanReport(plan.storage.controlRoot)
    const legacyPath = join(plan.storage.controlRoot, 'reports/primary.json')
    await writeFile(legacyPath, orphan.bytes, { flag: 'wx' })
    const before = (await readExperimentStorage(plan.storage.controlRoot)).state!
    expect(before.reports).toHaveLength(0)
    await evaluateExperiment(plan.storage.controlRoot, { unitKey: plan.units[0]!.unitKey, evaluatorKey: 'secondary' })
    const resumed = await runExperiment(plan, { continueUnstarted: true })
    const after = (await readExperimentStorage(plan.storage.controlRoot)).state!, report = after.reports[0]!
    expect(resumed.finalized).toBe(true)
    expect(after.units.map(unit => unit.started?.stored.eventId)).toEqual(before.units.map(unit => unit.started?.stored.eventId))
    expect(after.evaluations).toHaveLength(before.evaluations.length + 1)
    expect(report.payload.report.path).toMatch(/^reports\/primary-[0-9a-f]{64}\.json$/)
    expect(report.payload.report.path).not.toBe(orphan.path)
    expect(report.payload.report.path).not.toBe('reports/primary.json')
    expect(report.payload.selections.map(selection => selection.evaluationEvent)).toEqual(before.evaluations.map(event => ({ address: plan.experimentId, eventId: event.stored.eventId })))
    expect(await readFile(join(plan.storage.controlRoot, orphan.path))).toEqual(orphan.bytes)
    expect(await readFile(legacyPath)).toEqual(orphan.bytes)
    expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(true)
  }, 30_000)

  it('publishes the current controller provenance after interruption and preserves same-key report idempotency', async () => {
    const root = await directory(), plan = await planExperiment({ ...experimentDefinition(root), repetitions: 1 })
    const fault = interruptReportAppend()
    await expect(runExperiment(plan)).rejects.toMatchObject({ code: 'EXPERIMENT_COMMIT_UNKNOWN' })
    fault.mockRestore()
    const orphan = await orphanReport(plan.storage.controlRoot)
    useCompiledReportEntry()
    await runExperiment(plan, { continueUnstarted: true })
    const state = (await readExperimentStorage(plan.storage.controlRoot)).state!, reference = state.reports[0]!.payload.report
    expect(reference.path).not.toBe(orphan.path)
    const report = JSON.parse(await readFile(join(plan.storage.controlRoot, reference.path), 'utf8'))
    expect(report.provenance.reportController.entry).toMatch(/report\.js$/)
    expect(await readFile(join(plan.storage.controlRoot, orphan.path))).toEqual(orphan.bytes)
    const log = join(plan.storage.controlRoot, 'journal-store/sessions', plan.journalSessionId, 'events.log'), bytes = await readFile(log)
    expect((await reportExperiment(plan.storage.controlRoot, { reportKey: 'primary', kind: 'primary' })).reference).toEqual(reference)
    await expect(reportExperiment(plan.storage.controlRoot, { reportKey: 'primary', kind: 'primary', numericMetrics: ['count.model.started'] })).rejects.toThrow('report-metrics-changed')
    expect(await readFile(log)).toEqual(bytes)
    expect((await readExperimentStorage(plan.storage.controlRoot)).state!.position).toBe(state.position)
  }, 30_000)

  it('adopts the same complete orphan file when the report cut and provenance are unchanged', async () => {
    const root = await directory(), plan = await planExperiment({ ...experimentDefinition(root), repetitions: 1 })
    const fault = interruptReportAppend()
    await expect(runExperiment(plan)).rejects.toMatchObject({ code: 'EXPERIMENT_COMMIT_UNKNOWN' })
    fault.mockRestore()
    const orphan = await orphanReport(plan.storage.controlRoot)
    await runExperiment(plan, { continueUnstarted: true })
    const state = (await readExperimentStorage(plan.storage.controlRoot)).state!
    expect(state.reports[0]!.payload.report.path).toBe(orphan.path)
    expect(await readdir(join(plan.storage.controlRoot, 'reports'))).toEqual([orphan.path.slice('reports/'.length)])
    expect(await readFile(join(plan.storage.controlRoot, orphan.path))).toEqual(orphan.bytes)
  }, 30_000)

  it('keeps an already committed legacy report reference readable after the publication naming changes', async () => {
    const root = await directory(), plan = await planExperiment({ ...experimentDefinition(root), repetitions: 1 })
    const publish = artifacts.publishExperimentArtifact
    const legacy = vi.spyOn(artifacts, 'publishExperimentArtifact').mockImplementation((controlRoot, path, value, maximum) =>
      publish(controlRoot, path.startsWith('reports/primary-') ? 'reports/primary.json' : path, value, maximum))
    await runExperiment(plan)
    legacy.mockRestore()
    const state = (await readExperimentStorage(plan.storage.controlRoot)).state!, reference = state.reports[0]!.payload.report
    expect(reference.path).toBe('reports/primary.json')
    const bytes = await readFile(join(plan.storage.controlRoot, reference.path))
    useCompiledReportEntry()
    expect((await reportExperiment(plan.storage.controlRoot, { reportKey: 'primary', kind: 'primary', finalize: true })).reference).toEqual(reference)
    expect((await closeInterruptedExperiment(plan.storage.controlRoot, { predecessorStopped: true })).report).toEqual(reference)
    expect((await readExperimentStorage(plan.storage.controlRoot)).state!.position).toBe(state.position)
    expect(await readFile(join(plan.storage.controlRoot, reference.path))).toEqual(bytes)
    expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(true)
  }, 30_000)

  it('finalizes a physically committed report after lost acknowledgement without changing its original provenance', async () => {
    const root = await directory(), plan = await planExperiment({ ...experimentDefinition(root), repetitions: 1 })
    const fault = interruptReportAppend(true)
    await expect(runExperiment(plan)).rejects.toMatchObject({ code: 'EXPERIMENT_COMMIT_UNKNOWN' })
    fault.mockRestore()
    const before = (await readExperimentStorage(plan.storage.controlRoot)).state!, reference = before.reports[0]!.payload.report
    expect(before.finalized).toBeNull()
    const bytes = await readFile(join(plan.storage.controlRoot, reference.path))
    useCompiledReportEntry()
    const closed = await closeInterruptedExperiment(plan.storage.controlRoot, { predecessorStopped: true })
    expect(closed.report).toEqual(reference)
    expect(closed.state.reports).toHaveLength(1)
    expect(closed.state.position).toBe(before.position + 1)
    expect(await readFile(join(plan.storage.controlRoot, reference.path))).toEqual(bytes)
  }, 30_000)
})

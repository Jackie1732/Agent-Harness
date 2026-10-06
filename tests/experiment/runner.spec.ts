import { mkdtemp, rm, stat, readFile, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject, JsonValue } from '../../src/foundation/json.js'
import { planExperiment } from '../../src/experiment/definition.js'
import type { ExperimentPlan } from '../../src/experiment/definition-types.js'
import { runExperiment } from '../../src/experiment/runner.js'
import { runExperimentUnit } from '../../src/experiment/runner-unit.js'
import * as storageApi from '../../src/experiment/storage.js'
import type { ExperimentStorage } from '../../src/experiment/storage.js'
import { publishExperimentArtifact } from '../../src/experiment/artifacts.js'
import { experimentJsonDigest } from '../../src/experiment/parsing.js'
import { compareExperiments, inspectExperiment, verifyExperiment, evaluateExperiment, exportExperimentFixture } from '../../src/experiment/analysis.js'
import { reportExperiment } from '../../src/experiment/report.js'
import type { HostRuntimeBindings } from '../../src/host/slot.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { experimentDefinition } from './definition-fixture.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'
import { textFrames } from '../model/fixtures.js'
import { parseSessionId } from '../../src/session/ids.js'

const roots: string[] = []
async function directory() { const path = await mkdtemp(join(tmpdir(), 'atomic-experiment-run-')); roots.push(path); return path }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

function answered(root: string): JsonObject {
  const base = experimentDefinition(root)
  return { ...base, variants: (base.variants as readonly JsonObject[]).map((variant, index) => ({ ...variant,
    recipe: { ...(variant.recipe as JsonObject), members: ((variant.recipe as JsonObject).members as readonly JsonObject[]).map(member => ({ ...member,
      spec: { ...(member.spec as JsonObject), limits: { ...((member.spec as JsonObject).limits as JsonObject), maxReportEntries: 0 } },
      model: { ...(member.model as JsonObject), text: index === 0 ? '42' : '99' } })) } })) }
}

function distinctCallbacks(root: string): JsonObject {
  const base = answered(root)
  return { ...base, repetitions: 1, variants: (base.variants as readonly JsonObject[]).map((variant, index) => ({ ...variant,
    fixture: { kind: 'programmatic', fixtureKey: index === 0 ? 'a' : 'b', version: '1', sourceSha256: 'a'.repeat(64) } })) }
}

async function sealFirstUnit(plan: ExperimentPlan, storage: ExperimentStorage, binding: HostRuntimeBindings): Promise<void> {
  const unit = plan.units[0]!
  const result = await runExperimentUnit(plan, unit, storage, { fixtureBindings: { a: binding } })
  expect(result.closure).toBe('confirmed')
  expect(result.evidence?.coverage.complete).toBe(true)
  const evidence = await publishExperimentArtifact(plan.storage.controlRoot, `runs/${unit.unitKey}/evidence.json`,
    result.evidence as unknown as JsonValue, plan.evidenceLimits.maxEvidenceBytes)
  await storage.journal.sealUnit({ unitKey: unit.unitKey, outcome: result.outcome, reason: result.reason, closure: 'confirmed',
    evidenceDigest: experimentJsonDigest(result.evidence as unknown as JsonValue), evidence, measurement: null })
}

describe('independent experiment execution', () => {
  it('runs a fresh alternating matrix and freezes quality failures without stopping completed execution', async () => {
    const root = await directory(), plan = await planExperiment(answered(root))
    const result = await runExperiment(plan)
    expect(result.finalized).toBe(true)
    expect(result.units.every(unit => unit.sealed?.payload.outcome === 'completed')).toBe(true)
    const compared = await compareExperiments(plan.storage.controlRoot, { comparisonKey: 'a-versus-b', numericMetrics: ['count.model.started', 'time.totalMs'] })
    expect(compared.status).toBe('primary-fixed')
    expect(compared.summary.a.qualityCounts.pass).toBe(2)
    expect(compared.summary.b.qualityCounts.fail).toBe(2)
    expect(compared.numeric[0]!.delta.completePairs.mean).toBe(0)
    expect(compared.numeric[1]!.a.units.min).toBeGreaterThan(0)
    expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(true)
    for (const unit of plan.units) {
      const evidence = JSON.parse(await readFile(join(plan.storage.controlRoot, `runs/${unit.unitKey}/evidence.json`), 'utf8'))
      expect(evidence.output.text).toBe(unit.variantKey === 'a' ? '42' : '99')
      expect(evidence.sessions).toHaveLength(1)
      expect(evidence.metrics.counts['model.started'].value).toBe(1)
    }
    const first = plan.units[0]!
    const exported = await exportExperimentFixture(plan.storage.controlRoot, { unitKey: first.unitKey, sessionId: parseSessionId(first.recipe.members[0]!.sessionId) })
    expect(exported.status).toBe('supported')
    const before = await inspectExperiment(plan.storage.controlRoot)
    await evaluateExperiment(plan.storage.controlRoot, { unitKey: first.unitKey })
    expect((await inspectExperiment(plan.storage.controlRoot)).state?.position).toBe(before.state?.position)
    await reportExperiment(plan.storage.controlRoot, { reportKey: 'review', kind: 'posthoc' })
    const after = await compareExperiments(plan.storage.controlRoot, { comparisonKey: 'a-versus-b' })
    expect(after.rows.map(row => row.a.evaluation)).toEqual(compared.rows.map(row => row.a.evaluation))
    await expect(runExperiment(plan, { continueUnstarted: true })).rejects.toThrow('experiment-cannot-continue')
  }, 30_000)

  it('cancels before starting any Host and preserves every planned denominator', async () => {
    const root = await directory(), plan = await planExperiment(answered(root)), controller = new AbortController()
    controller.abort()
    const result = await runExperiment(plan, { signal: controller.signal })
    expect(result.stoppedBy).toBe('cancelled')
    expect(result.units.every(unit => unit.started === null && unit.notRun === 'cancelled-before-start')).toBe(true)
    await expect(stat(plan.units[0]!.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    const compared = await compareExperiments(plan.storage.controlRoot, { comparisonKey: 'a-versus-b', numericMetrics: ['time.totalMs'] })
    expect(compared.summary.a.plannedPassRate).toBe(0)
    expect(compared.summary.a.evaluatedPassRate).toBeNull()
    expect(compared.numeric[0]!.delta.completePairs.mean).toBeNull()
  })

  it('preflights a missing executable fixture binding before creating storage', async () => {
    const root = await directory(), base = answered(root)
    const plan = await planExperiment({ ...base, variants: (base.variants as readonly JsonObject[]).map(variant => ({ ...variant,
      fixture: { kind: 'programmatic', fixtureKey: 'callback', version: '1', sourceSha256: 'a'.repeat(64) } })) })
    await expect(runExperiment(plan)).rejects.toThrow('fixture-binding-missing')
    await expect(stat(plan.storage.controlRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires only unstarted callbacks on continuation and rejects a missing pending callback before Journal writes', async () => {
    const root = await directory(), plan = await planExperiment(distinctCallbacks(root)), storage = await storageApi.createExperimentStorage(plan)
    let firstProviders = 0, secondProviders = 0
    try {
      await sealFirstUnit(plan, storage, { createModelProvider: member => {
        firstProviders++
        return new ScriptedModelProvider({ ...member.model, script: () => textFrames('42') })
      } })
    } finally { await storage.dispose() }
    const before = (await storageApi.readExperimentStorage(plan.storage.controlRoot)).state!.position
    await expect(runExperiment(plan, { continueUnstarted: true })).rejects.toThrow('fixture-binding-missing')
    expect((await storageApi.readExperimentStorage(plan.storage.controlRoot)).state!.position).toBe(before)
    await expect(stat(plan.units[1]!.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    const result = await runExperiment(plan, { continueUnstarted: true, fixtureBindings: { b: { createModelProvider: member => {
      secondProviders++
      return new ScriptedModelProvider({ ...member.model, script: () => textFrames('42') })
    } } } })
    expect(result.units.every(unit => unit.sealed?.payload.outcome === 'completed')).toBe(true)
    expect(firstProviders).toBe(1)
    expect(secondProviders).toBe(1)
    expect((await storageApi.readExperimentStorage(plan.storage.controlRoot)).state!.evaluations).toHaveLength(2)
  }, 30_000)

  it('uses the locked Journal reread when another controller seals a unit after the initial Reader cut', async () => {
    const root = await directory(), plan = await planExperiment(distinctCallbacks(root)), storage = await storageApi.createExperimentStorage(plan)
    const read = storageApi.readExperimentStorage
    let firstProviders = 0, secondProviders = 0
    vi.spyOn(storageApi, 'readExperimentStorage').mockImplementationOnce(async input => {
      const stale = await read(input)
      try {
        await sealFirstUnit(plan, storage, { createModelProvider: member => {
          firstProviders++
          return new ScriptedModelProvider({ ...member.model, script: () => textFrames('42') })
        } })
      } finally { await storage.dispose() }
      return stale
    })
    const result = await runExperiment(plan, { continueUnstarted: true, fixtureBindings: { b: { createModelProvider: member => {
      secondProviders++
      return new ScriptedModelProvider({ ...member.model, script: () => textFrames('42') })
    } } } })
    expect(result.units.every(unit => unit.sealed?.payload.outcome === 'completed')).toBe(true)
    expect(firstProviders).toBe(1)
    expect(secondProviders).toBe(1)
  }, 30_000)

  it.each(['policy', 'cancelled'] as const)('needs no pending callback when continuation is stopped by %s', async stoppedBy => {
    const root = await directory(), base = distinctCallbacks(root)
    const plan = await planExperiment({ ...base, runPolicy: { ...(base.runPolicy as JsonObject), onCaseFailure: 'stop' } })
    const storage = await storageApi.createExperimentStorage(plan)
    try {
      await sealFirstUnit(plan, storage, { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
        ...(stoppedBy === 'policy' ? { onPrepare: () => { throw new Error('fixture request mismatch') } } : {}),
        script: () => textFrames('42') }) })
    } finally { await storage.dispose() }
    const controller = new AbortController()
    if (stoppedBy === 'cancelled') controller.abort()
    const result = await runExperiment(plan, { continueUnstarted: true, signal: controller.signal })
    expect(result.stoppedBy).toBe(stoppedBy)
    expect(result.units[1]!.notRun).toBe(stoppedBy === 'policy' ? 'skipped-by-policy' : 'cancelled-before-start')
    await expect(stat(plan.units[1]!.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('executes Workflow using a unit-local absolute deadline and selects the accepted artifact', async () => {
    const root = await directory(), base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
    const plan = await planExperiment({ ...base, repetitions: 1, comparisons: [], variants: [{ ...variant,
      recipe: runnableWorkflowConfig(`${root}/template`), bindings: [{ kind: 'workflow', caseKey: 'question', inputMode: 'inline', materials: [],
        workflowKey: 'research', durationMs: 60_000, nodeTasks: [{ nodeKey: 'read', prefix: 'Research: ' }],
        output: { kind: 'workflow-artifact', nodeKey: 'write', artifactName: 'report' } }] }] })
    const result = await runExperiment(plan)
    expect(result.units[0]!.sealed?.payload.outcome).toBe('completed')
    const unit = plan.units[0]!, actual = JSON.parse(await readFile(join(plan.storage.controlRoot, result.units[0]!.started!.payload.recipe.path), 'utf8'))
    expect(actual.workflows.definitions[0].definition.deadline).not.toBe('2030-01-01T00:00:00.000Z')
    const evidence = JSON.parse(await readFile(join(plan.storage.controlRoot, `runs/${unit.unitKey}/evidence.json`), 'utf8'))
    expect(evidence.output.reason).toBeUndefined()
    expect(evidence.output).toMatchObject({ status: 'available', text: 'final report' })
    expect(evidence.metrics.counts['workflow.closed'].value).toBe(1)
    expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(true)
  }, 30_000)

  it('detects modified sealed bytes without accepting the modified artifact as a new original', async () => {
    const root = await directory(), base = answered(root)
    const plan = await planExperiment({ ...base, repetitions: 1 })
    await runExperiment(plan)
    await appendFile(join(plan.storage.controlRoot, `runs/${plan.units[0]!.unitKey}/evidence.json`), '\n')
    const result = await verifyExperiment(plan.storage.controlRoot)
    expect(result.complete).toBe(false)
    expect(result.files.some(file => file.reasons.includes('referenced-artifact-changed'))).toBe(true)
    await expect(compareExperiments(plan.storage.controlRoot, { comparisonKey: 'a-versus-b' })).rejects.toThrow('referenced-artifact-changed')
  }, 30_000)

  it('verifies frozen input copies independently of the mutable execution workspace', async () => {
    const root = await directory(), base = answered(root)
    const plan = await planExperiment({ ...base, repetitions: 1 })
    await runExperiment(plan)
    const path = join(plan.storage.controlRoot, 'inputs/question/notes.txt')
    const before = (await inspectExperiment(plan.storage.controlRoot)).state!.position
    await writeFile(path, 'changed source')
    const verified = await verifyExperiment(plan.storage.controlRoot)
    expect(verified.complete).toBe(false)
    expect(verified.files.find(file => file.path === 'inputs/question/notes.txt')).toMatchObject({ verified: false, reasons: ['frozen-input-changed'] })
    expect((await inspectExperiment(plan.storage.controlRoot)).state!.position).toBe(before)
    expect(await readFile(path, 'utf8')).toBe('changed source')
  }, 30_000)
})

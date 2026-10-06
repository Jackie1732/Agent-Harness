import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { createExperimentStorage, readExperimentStorage } from '../../src/experiment/storage.js'
import { closeInterruptedExperiment, statusExperiment } from '../../src/experiment/administration.js'
import { experimentDefinition } from './definition-fixture.js'
import { evaluateExperimentOutput } from '../../src/experiment/evaluation.js'
import { recordExperimentReport } from '../../src/experiment/report.js'

const roots: string[] = []
async function root() { const path = await mkdtemp(join(tmpdir(), 'atomic-experiment-administration-')); roots.push(path); return path }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const file = { path: 'runs/unpublished-recipe.json', sha256: 'a'.repeat(64), byteLength: 10 }

describe('interrupted experiment administration', () => {
  it('reads missing and held roots without creating files or acquiring the controller lock', async () => {
    const path = await root(), missing = join(path, 'absent')
    expect(await statusExperiment(missing)).toEqual({ kind: 'uninitialized', location: null })
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    const plan = await planExperiment(experimentDefinition(path)), storage = await createExperimentStorage(plan)
    try {
      const log = join(plan.storage.controlRoot, 'journal-store', 'sessions', plan.journalSessionId, 'events.log')
      const bytes = await readFile(log)
      expect(await statusExperiment(storage.location)).toMatchObject({ kind: 'initialized', cut: 1, finalized: false, activeUnit: null,
        counts: { planned: 4, started: 0, sealed: 0, unresolved: 0, unstarted: 4 } })
      expect(await readFile(log)).toEqual(bytes)
    } finally { await storage.dispose() }
  })
  it('requires predecessor confirmation and the exact residual token, then closes metadata without any Host creation', async () => {
    const path = await root(), base = experimentDefinition(path), variant = (base.variants as readonly JsonObject[])[0]!
    const plan = await planExperiment({ ...base, comparisons: [], variants: [variant] }), storage = await createExperimentStorage(plan), unit = plan.units[0]!
    const marker = join(plan.storage.controlRoot, '.atomic-harness.lock'), oldMarker = await readFile(marker), oldToken = storage.lockToken
    await storage.journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file })
    await storage.dispose()
    await writeFile(marker, oldMarker)
    const log = join(plan.storage.controlRoot, 'journal-store', 'sessions', plan.journalSessionId, 'events.log'), before = await readFile(log)
    await expect(closeInterruptedExperiment(storage.location, { predecessorStopped: false as never })).rejects.toThrow('predecessor-stop-confirmation-required')
    await expect(closeInterruptedExperiment(storage.location, { predecessorStopped: true })).rejects.toMatchObject({ code: 'HOST_LOCKED' })
    await expect(closeInterruptedExperiment(storage.location, { predecessorStopped: true, expectedToken: 'wrong' })).rejects.toThrow('unlock-token-mismatch')
    expect(await readFile(log)).toEqual(before)
    const closed = await closeInterruptedExperiment(storage.location, { predecessorStopped: true, expectedToken: oldToken })
    expect(closed.state.units[0]!.unresolved!.payload).toMatchObject({ outcome: 'interrupted', closure: 'unknown', evidence: null })
    expect(closed.state.units[1]!.notRun).toBe('not-run-after-interruption')
    expect(closed.state.finalized?.payload.reportKey).toBe('interrupted')
    expect(closed.state.reports[0]!.payload.selections).toEqual(plan.units.map(unit => ({ unitKey: unit.unitKey, evaluationEvent: null })))
    for (const planned of plan.units) await expect(stat(planned.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    const after = await readFile(log)
    const repeated = await closeInterruptedExperiment(storage.location, { predecessorStopped: true, expectedToken: oldToken })
    expect(repeated.report).toEqual(closed.report)
    expect(await readFile(log)).toEqual(after)
    expect(await statusExperiment(storage.location)).toMatchObject({ finalized: true, primaryReportKey: 'interrupted', counts: { unresolved: 1, unstarted: 1 } })
  })
  it('preserves sealed execution and exact primary evaluations while closing the remaining unstarted matrix', async () => {
    const path = await root(), base = experimentDefinition(path), variant = (base.variants as readonly JsonObject[])[0]!
    const plan = await planExperiment({ ...base, comparisons: [], variants: [variant] }), storage = await createExperimentStorage(plan), unit = plan.units[0]!
    await storage.journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file })
    const sealed = await storage.journal.sealUnit({ unitKey: unit.unitKey, outcome: 'completed', reason: '', closure: 'confirmed',
      evidenceDigest: 'a'.repeat(64), evidence: { ...file, path: 'runs/missing-evidence.json' }, measurement: null })
    const result = evaluateExperimentOutput({ unitKey: unit.unitKey, case: plan.dataset.cases[0]!, evaluator: plan.evaluators[0]!, evidenceDigest: 'a'.repeat(64),
      output: { status: 'available', mediaType: 'text/plain', sourceMediaType: 'text/plain', text: '43', byteLength: 2, sha256: 'b'.repeat(64), sources: [], workspaceObservation: null },
      maxJsonBytes: plan.evidenceLimits.maxEvidenceBytes })
    const evaluation = await storage.journal.settleEvaluation({ unitKey: unit.unitKey, evidenceDigest: 'a'.repeat(64),
      evaluatorDigest: plan.dataset.cases[0]!.evaluatorDigest, evaluatorVersion: '1', result: result as unknown as JsonObject })
    await storage.dispose()
    const closed = await closeInterruptedExperiment(storage.location, { predecessorStopped: true })
    expect(closed.state.units[0]!.sealed!.stored.eventId).toBe(sealed.stored.eventId)
    expect(closed.state.units[1]!.notRun).toBe('not-run-after-interruption')
    expect(closed.state.reports[0]!.payload.selections[0]).toEqual({ unitKey: unit.unitKey,
      evaluationEvent: { address: plan.experimentId, eventId: evaluation.stored.eventId } })
    expect((await readExperimentStorage(storage.location)).kind).toBe('initialized')
    for (const planned of plan.units) await expect(stat(planned.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('adopts the committed primary report after an interrupted finalization and rejects a replacement key', async () => {
    const path = await root(), plan = await planExperiment(experimentDefinition(path)), storage = await createExperimentStorage(plan)
    const report = await recordExperimentReport(storage, { reportKey: 'original', kind: 'primary' })
    await storage.dispose()
    expect(await statusExperiment(storage.location)).toMatchObject({ finalized: false, primaryReportKey: 'original' })
    await expect(closeInterruptedExperiment(storage.location, { predecessorStopped: true, reportKey: 'replacement' })).rejects.toThrow('primary-report-key-changed')
    const closed = await closeInterruptedExperiment(storage.location, { predecessorStopped: true })
    expect(closed.report).toEqual(report.reference)
    expect(closed.state.finalized?.payload.reportKey).toBe('original')
    expect(closed.state.reports).toHaveLength(1)
    expect(closed.state.units.every(unit => unit.notRun === 'not-run-after-interruption')).toBe(true)
    await expect(closeInterruptedExperiment(storage.location, { predecessorStopped: true, reportKey: 'replacement' })).rejects.toThrow('primary-report-key-changed')
  })
})

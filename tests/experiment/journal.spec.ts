import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import type { SessionBackend } from '../../src/session/backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { ExperimentJournal } from '../../src/experiment/journal.js'
import { decodeExperimentDerivedFrom, experimentEventCatalog } from '../../src/experiment/journal-events.js'
import { projectExperimentJournal } from '../../src/experiment/journal-projection.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { experimentDefinition } from './definition-fixture.js'
import type { JsonObject } from '../../src/foundation/json.js'

const file = { path: 'runs/evidence.json', sha256: 'a'.repeat(64), byteLength: 10 }
async function setup(options: { readonly unknownAppend?: boolean; readonly repetitions?: number } = {}) {
  const base = experimentDefinition(join(tmpdir(), `experiment-journal-${randomUUID()}`))
  const variant = (base.variants as readonly JsonObject[])[0]!
  const plan = await planExperiment({ ...base, variants: [variant], comparisons: [], repetitions: options.repetitions ?? 1 })
  const memory = new MemorySessionBackend({ maxRecordBytes: plan.storage.maxRecordBytes })
  const backend: SessionBackend = options.unknownAppend === true ? {
    maxRecordBytes: memory.maxRecordBytes, create: header => memory.create(header), readPrefix: (id, through) => memory.readPrefix(id, through), dispose: () => memory.dispose(),
    openWriter: async (id, validateCommitted) => {
      const writer = await memory.openWriter(id, validateCommitted)
      return { ...writer, append: async (position, event) => {
        const result = await writer.append(position, event)
        if (event.type === 'experiment/unit-started') throw new Error('lost append acknowledgment')
        return result
      } }
    },
  } : memory
  const repository = new SessionRepository({ backend, catalog: experimentEventCatalog, maxLineageDepth: 0 })
  const handle = await repository.create({ sessionId: plan.journalSessionId })
  const journal = new ExperimentJournal(handle)
  await journal.recordPlan(plan)
  return { plan, repository, handle, journal, unit: plan.units[0]! }
}

describe('independent experiment Journal', () => {
  it('returns exact committed facts for duplicate commands and rejects changed payloads', async () => {
    const { journal, unit, repository } = await setup()
    try {
      const payload = { unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file }
      const [first, second] = await Promise.all([journal.startUnit(payload), journal.startUnit(payload)])
      expect(first.stored.eventId).toBe(second.stored.eventId)
      expect(journal.snapshot().position).toBe(2)
      await expect(journal.startUnit({ ...payload, recipeDigest: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'EXPERIMENT_CONFLICT' })
      await journal.sealUnit({ unitKey: unit.unitKey, outcome: 'failed', reason: 'fixture-error', closure: 'confirmed', evidenceDigest: 'a'.repeat(64), evidence: file, measurement: null })
      expect(journal.snapshot().activeUnit).toBe(null)
      await expect(journal.unresolveUnit({ unitKey: unit.unitKey, outcome: 'failed', reason: 'late', closure: 'unknown', evidence: null })).rejects.toMatchObject({ code: 'EXPERIMENT_STATE_INVALID' })
    } finally { await repository.dispose() }
  })
  it('freezes original dispositions and primary reports while permitting posthoc metadata', async () => {
    const { journal, unit, repository, plan } = await setup()
    try {
      await journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file })
      await journal.sealUnit({ unitKey: unit.unitKey, outcome: 'completed', reason: '', closure: 'confirmed', evidenceDigest: 'a'.repeat(64), evidence: file, measurement: null })
      const evaluation = await journal.settleEvaluation({ unitKey: unit.unitKey, evidenceDigest: 'a'.repeat(64), evaluatorDigest: plan.dataset.cases[0]!.evaluatorDigest, evaluatorVersion: '1', result: { overall: 'fail' } })
      await journal.recordReport({ reportKey: 'primary', kind: 'primary', report: file, cut: journal.snapshot().position,
        selections: [{ unitKey: unit.unitKey, evaluationEvent: { address: plan.experimentId, eventId: evaluation.stored.eventId } }] })
      await journal.finalize({ reportKey: 'primary', unstarted: [] })
      expect(journal.snapshot().finalized).not.toBe(null)
      await journal.recordReport({ reportKey: 'later', kind: 'posthoc', report: { ...file, path: 'reports/later.json' }, cut: journal.snapshot().position, selections: [] })
      await journal.settleEvaluation({ unitKey: unit.unitKey, evidenceDigest: 'a'.repeat(64), evaluatorDigest: 'b'.repeat(64), evaluatorVersion: '2', result: { overall: 'pass' } })
      expect(journal.snapshot().reports[0]!.payload.selections[0]!.evaluationEvent).toEqual({ address: plan.experimentId, eventId: evaluation.stored.eventId })
      await expect(journal.recordReport({ reportKey: 'new-main', kind: 'primary', report: file, cut: journal.snapshot().position, selections: [{ unitKey: unit.unitKey, evaluationEvent: null }] })).rejects.toThrow('report-not-admitted')
      await expect(journal.finalize({ reportKey: 'different', unstarted: [] })).rejects.toMatchObject({ code: 'EXPERIMENT_CONFLICT' })
      expect(journal.snapshot().units[0]!.sealed!.payload.outcome).toBe('completed')
    } finally { await repository.dispose() }
  })
  it('requires every planned unit to have an original disposition or an explicit not-run reason', async () => {
    const { journal, unit, repository } = await setup()
    try {
      await journal.recordReport({ reportKey: 'closed', kind: 'primary', report: file, cut: journal.snapshot().position, selections: [{ unitKey: unit.unitKey, evaluationEvent: null }] })
      await expect(journal.recordReport({ reportKey: 'second-primary', kind: 'primary', report: file, cut: journal.snapshot().position,
        selections: [{ unitKey: unit.unitKey, evaluationEvent: null }] })).rejects.toThrow('primary-report-exists')
      await expect(journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file })).rejects.toThrow('primary-report-frozen')
      await expect(journal.finalize({ reportKey: 'closed', unstarted: [] })).rejects.toThrow('finalize-incomplete-matrix')
      await journal.finalize({ reportKey: 'closed', unstarted: [{ unitKey: unit.unitKey, reason: 'not-run-after-interruption' }] })
      expect(journal.snapshot().units[0]!.notRun).toBe('not-run-after-interruption')
      await expect(journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file })).rejects.toThrow('experiment-finalized')
    } finally { await repository.dispose() }
  })
  it('stops admission after an unknown append and reopens the actually committed prefix', async () => {
    const { journal, unit, repository, handle, plan } = await setup({ unknownAppend: true })
    try {
      await expect(journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file })).rejects.toMatchObject({ code: 'EXPERIMENT_COMMIT_UNKNOWN' })
      expect(journal.accepting).toBe(false)
      expect(journal.snapshot().activeUnit).toBe(null)
      expect(projectExperimentJournal(await repository.read(plan.journalSessionId)).activeUnit).toBe(unit.unitKey)
      await expect(journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file })).rejects.toMatchObject({ code: 'EXPERIMENT_INACTIVE' })
      await handle.dispose()
      const reopened = new ExperimentJournal(await repository.open(plan.journalSessionId))
      expect(reopened.snapshot().activeUnit).toBe(unit.unitKey)
      await reopened.unresolveUnit({ unitKey: unit.unitKey, outcome: 'interrupted', reason: 'process-loss', closure: 'unknown', evidence: null })
      expect(reopened.snapshot().units[0]!.unresolved!.payload.outcome).toBe('interrupted')
    } finally { await repository.dispose() }
  })
  it('distinguishes a sealed business-unknown result from unresolved evidence after confirmed resource closure', async () => {
    const { journal, unit, plan, repository } = await setup({ repetitions: 2 })
    try {
      const next = plan.units[1]!
      await expect(journal.startUnit({ unitKey: next.unitKey, templateDigest: next.recipeDigest, recipeDigest: next.recipeDigest, recipe: file })).rejects.toThrow('unit-start-template-or-order')
      await journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file })
      await expect(journal.startUnit({ unitKey: next.unitKey, templateDigest: next.recipeDigest, recipeDigest: next.recipeDigest, recipe: file })).rejects.toThrow('unit-start-not-admitted')
      await journal.sealUnit({ unitKey: unit.unitKey, outcome: 'result-unknown', reason: 'external-tool', closure: 'confirmed', evidenceDigest: 'a'.repeat(64), evidence: file, measurement: null })
      await journal.startUnit({ unitKey: next.unitKey, templateDigest: next.recipeDigest, recipeDigest: next.recipeDigest, recipe: file })
      await journal.unresolveUnit({ unitKey: next.unitKey, outcome: 'completed', reason: 'evidence-publication-failed', closure: 'confirmed', evidence: null })
      expect(journal.snapshot().units[1]!.unresolved!.payload).toMatchObject({ outcome: 'completed', closure: 'confirmed' })
      expect(journal.snapshot().activeUnit).toBe(null)
    } finally { await repository.dispose() }
  })
  it('fixes primary evaluation references at a disposed cut and rejects dangling or omitted eligible selections', async () => {
    const { journal, unit, plan, repository } = await setup()
    try {
      await journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file })
      await expect(journal.recordReport({ reportKey: 'early', kind: 'primary', report: file, cut: journal.snapshot().position,
        selections: [{ unitKey: unit.unitKey, evaluationEvent: null }] })).rejects.toThrow('primary-report-before-disposition')
      await journal.sealUnit({ unitKey: unit.unitKey, outcome: 'completed', reason: '', closure: 'confirmed', evidenceDigest: 'a'.repeat(64), evidence: file, measurement: null })
      const cut = journal.snapshot().position
      const evaluation = await journal.settleEvaluation({ unitKey: unit.unitKey, evidenceDigest: 'a'.repeat(64), evaluatorDigest: plan.dataset.cases[0]!.evaluatorDigest,
        evaluatorVersion: '1', result: { overall: 'pass' } })
      const selections = [{ unitKey: unit.unitKey, evaluationEvent: { address: plan.experimentId, eventId: evaluation.stored.eventId } }]
      await expect(journal.recordReport({ reportKey: 'future', kind: 'primary', report: file, cut, selections })).rejects.toThrow('primary-report-evaluation-reference')
      await expect(journal.recordReport({ reportKey: 'omitted', kind: 'primary', report: file, cut: journal.snapshot().position,
        selections: [{ unitKey: unit.unitKey, evaluationEvent: null }] })).rejects.toThrow('primary-report-evaluation-reference')
      await journal.recordReport({ reportKey: 'fixed-missing', kind: 'primary', report: file, cut, selections: [{ unitKey: unit.unitKey, evaluationEvent: null }] })
      await journal.finalize({ reportKey: 'fixed-missing', unstarted: [] })
      expect(journal.snapshot().reports[0]!.payload.selections[0]!.evaluationEvent).toBe(null)
    } finally { await repository.dispose() }
  })
  it('links derived copies to the exact original disposition, evidence and actual recipe without changing primary results', async () => {
    const { journal, unit, plan, repository } = await setup()
    try {
      const started = await journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file })
      const sealed = await journal.sealUnit({ unitKey: unit.unitKey, outcome: 'completed', reason: '', closure: 'confirmed',
        evidenceDigest: 'a'.repeat(64), evidence: file, measurement: null })
      const primary = await journal.settleEvaluation({ unitKey: unit.unitKey, evidenceDigest: 'a'.repeat(64), evaluatorDigest: plan.dataset.cases[0]!.evaluatorDigest,
        evaluatorVersion: '1', result: { overall: 'fail' } })
      await journal.recordReport({ reportKey: 'primary', kind: 'primary', report: file, cut: journal.snapshot().position,
        selections: [{ unitKey: unit.unitKey, evaluationEvent: { address: plan.experimentId, eventId: primary.stored.eventId } }] })
      await journal.finalize({ reportKey: 'primary', unstarted: [] })
      const source = { kind: 'reviewed-copy/v1' as const, actionKey: 'recovery', originalDisposition: { address: plan.experimentId, eventId: sealed.stored.eventId },
        originalEvidence: file, recipeDigest: unit.recipeDigest, sourceRoot: `${unit.hostRoot}-reviewed` }
      expect(() => decodeExperimentDerivedFrom({ bogus: true })).toThrow('derivedFrom-fields')
      const payload = { unitKey: unit.unitKey, evidenceKey: 'reviewed', evidenceDigest: 'b'.repeat(64), evidence: { ...file, path: 'derived/reviewed/evidence.json' }, derivedFrom: source }
      await expect(journal.recordEvidence({ ...payload, derivedFrom: { ...source, originalDisposition: { ...source.originalDisposition, eventId: started.stored.eventId } } })).rejects.toThrow('derived-evidence-source')
      await expect(journal.recordEvidence({ ...payload, derivedFrom: { ...source, originalEvidence: null } })).rejects.toThrow('derived-evidence-source')
      await expect(journal.recordEvidence({ ...payload, derivedFrom: { ...source, recipeDigest: 'c'.repeat(64) } })).rejects.toThrow('derived-evidence-source')
      const recorded = await journal.recordEvidence(payload)
      expect((await journal.recordEvidence(payload)).stored.eventId).toBe(recorded.stored.eventId)
      await journal.settleEvaluation({ unitKey: unit.unitKey, evidenceDigest: 'b'.repeat(64), evaluatorDigest: plan.dataset.cases[0]!.evaluatorDigest,
        evaluatorVersion: '1', result: { overall: 'pass' } })
      expect(journal.snapshot().units[0]!.sealed!.stored.eventId).toBe(sealed.stored.eventId)
      expect(journal.snapshot().reports[0]!.payload.selections[0]!.evaluationEvent).toEqual({ address: plan.experimentId, eventId: primary.stored.eventId })
    } finally { await repository.dispose() }
  })
})

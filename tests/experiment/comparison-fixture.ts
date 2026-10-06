import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '../../src/foundation/json.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import type { ExperimentPlan, ExperimentUnit } from '../../src/experiment/definition-types.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { experimentDefinition } from './definition-fixture.js'
import { experimentEventCatalog } from '../../src/experiment/journal-events.js'
import { ExperimentJournal } from '../../src/experiment/journal.js'
import { experimentBytesDigest } from '../../src/experiment/parsing.js'
import { evaluateExperimentOutput } from '../../src/experiment/evaluation.js'
import type { ComparisonObservation, ExperimentResultSet } from '../../src/experiment/comparison-types.js'
import type { ExperimentOutcome } from '../../src/experiment/journal-types.js'
import { selectPrimaryExperimentEvaluations } from '../../src/experiment/comparison.js'

export async function comparisonPlan(twoCases = false, repetitions = 2): Promise<ExperimentPlan> {
  const definition: JsonObject = { ...experimentDefinition(join(tmpdir(), `atomic-comparison-${randomUUID()}`)), repetitions }
  if (!twoCases) return await planExperiment(definition)
  const dataset = definition.dataset as JsonObject, first = (dataset.cases as readonly JsonObject[])[0]!
  const second = { ...first, caseKey: 'second' }
  const variants = (definition.variants as readonly JsonObject[]).map(variant => {
    const binding = (variant.bindings as readonly JsonObject[])[0]!
    return { ...variant, bindings: [binding, { ...binding, caseKey: 'second' }] }
  })
  return await planExperiment({ ...definition, dataset: { ...dataset, cases: [first, second] }, variants })
}
export interface ObservationSpec {
  readonly outcome?: ExperimentOutcome
  readonly quality?: 'pass' | 'fail' | 'unavailable' | 'missing'
  readonly time?: number | null
  readonly unresolved?: boolean
}
export async function comparisonFixture(plan: ExperimentPlan, choose: (unit: ExperimentUnit) => ObservationSpec = () => ({})) {
  const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: plan.storage.maxRecordBytes }),
    catalog: experimentEventCatalog, maxLineageDepth: 0 })
  const handle = await repo.create({ sessionId: plan.journalSessionId }); const journal = new ExperimentJournal(handle)
  await journal.recordPlan(plan)
  const observations: ComparisonObservation[] = []
  const pendingEvaluations: { unit: ExperimentUnit; digest: string; quality: ObservationSpec['quality'] }[] = []
  const file = (path: string) => ({ path, sha256: experimentBytesDigest(Buffer.from(path)), byteLength: 1 })
  const evaluate = async (unit: ExperimentUnit, digest: string, quality: ObservationSpec['quality'] = 'pass') => {
    const item = plan.dataset.cases.find(item => item.caseKey === unit.caseKey)!, evaluator = plan.evaluators.find(item => item.evaluatorKey === plan.dataset.cases[0]!.primaryEvaluatorKey)!
    const text = quality === 'fail' ? 'wrong' : '42'
    const result = evaluateExperimentOutput({ unitKey: unit.unitKey, case: item, evaluator, evidenceDigest: digest, maxJsonBytes: 65536,
      output: quality === 'unavailable' ? { status: 'unavailable', reason: 'source-unavailable', sources: [] }
        : { status: 'available', mediaType: item.output.mediaType, sourceMediaType: 'text/plain', text, byteLength: Buffer.byteLength(text), sha256: experimentBytesDigest(Buffer.from(text)), sources: [], workspaceObservation: null } })
    return await journal.settleEvaluation({ unitKey: unit.unitKey, evidenceDigest: digest, evaluatorDigest: result.evaluatorDigest,
      evaluatorVersion: result.evaluatorVersion, result: result as unknown as JsonObject })
  }
  for (const unit of plan.units) {
    const spec = choose(unit), digest = experimentBytesDigest(Buffer.from(`${unit.unitKey}:original`)), measurement = spec.time === null ? null : file(`${unit.unitKey}/measurement.json`)
    await journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: file(`${unit.unitKey}/recipe.json`) })
    if (spec.unresolved) {
      await journal.unresolveUnit({ unitKey: unit.unitKey, outcome: spec.outcome ?? 'interrupted', reason: 'closure-unknown', closure: 'unknown', evidence: null })
      break
    }
    await journal.sealUnit({ unitKey: unit.unitKey, outcome: spec.outcome ?? 'completed', reason: 'observed', closure: 'confirmed', evidenceDigest: digest,
      evidence: file(`${unit.unitKey}/evidence.json`), measurement })
    observations.push({ unitKey: unit.unitKey, evidenceDigest: digest, metrics: null, measurement: measurement === null ? null : { reference: measurement,
      value: { version: 1, unitKey: unit.unitKey, clock: 'performance.now', environment: { origin: 'synthetic-statistics-fixture' }, initMs: 0, driveMs: spec.time ?? 10, shutdownMs: 0, totalMs: spec.time ?? 10, overdueMs: 0 } } })
    if (spec.quality === 'missing') pendingEvaluations.push({ unit, digest, quality: 'pass' })
    else await evaluate(unit, digest, spec.quality)
  }
  const results = (): ExperimentResultSet => ({ plan, journal: journal.snapshot(), cut: journal.snapshot().position, observations })
  return { journal, observations, results, evaluatePending: async () => { for (const pending of pendingEvaluations) await evaluate(pending.unit, pending.digest, pending.quality) },
    finalize: async () => {
      const current = results(), selections = selectPrimaryExperimentEvaluations(current)
      await journal.recordReport({ reportKey: 'primary', kind: 'primary', report: file('reports/primary.json'), cut: current.cut, selections: selections as unknown as readonly JsonObject[] })
      await journal.finalize({ reportKey: 'primary', unstarted: journal.snapshot().units.filter(unit => unit.started === null).map(unit => ({ unitKey: unit.unitKey, reason: 'not-run-after-interruption' })) })
    }, dispose: async () => { await journal.dispose(); await repo.dispose() } }
}

import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { ExperimentUnstartedReason } from './journal-types.js'
import type { ComparisonNumericMetricName } from './comparison-types.js'
import type { ExperimentStorage } from './storage.js'
import { openExperimentStorage } from './storage.js'
import { loadExperimentResultSet } from './analysis.js'
import { compareExperimentResults, selectPrimaryExperimentEvaluations } from './comparison.js'
import { publishExperimentArtifact, readExperimentArtifact } from './artifacts.js'
import { experimentKey, experimentJsonDigest, experimentObject } from './parsing.js'
import { ExperimentError } from './errors.js'
import { experimentControllerEnvironment } from './environment.js'
import { decodeExperimentEvidence } from './evidence-codec.js'
import { verifyExperimentEvidence } from './evidence.js'

export interface ExperimentReportOptions {
  readonly reportKey: string
  readonly kind: 'primary' | 'posthoc'
  readonly finalize?: boolean
  readonly unstartedReason?: ExperimentUnstartedReason
  readonly numericMetrics?: readonly ComparisonNumericMetricName[]
}

/** Write a new bounded report under metadata ownership, preserving all existing report bytes. */
export async function reportExperiment(root: string, options: ExperimentReportOptions) {
  const storage = await openExperimentStorage(root)
  try { return await recordExperimentReport(storage, options) }
  finally { await storage.dispose() }
}

/** Authenticate a report's recorded sources at its Journal cut, then optionally finalize its primary matrix. */
export async function recordExperimentReport(storage: ExperimentStorage, options: ExperimentReportOptions) {
  const reportKey = experimentKey(options.reportKey, 'report-key')
  if (options.finalize === true && options.kind !== 'primary') throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'finalize-requires-primary-report')
  const state = storage.journal.snapshot(), plan = state.plan!
  const existing = state.reports.find(event => event.payload.reportKey === reportKey)
  const numericMetrics = options.numericMetrics ?? []
  if (existing === undefined && options.kind === 'primary' && state.reports.some(event => event.payload.kind === 'primary')) throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'primary-report-exists')
  let event = existing
  const results = await loadExperimentResultSet(storage.location.controlRoot, state, true, existing?.payload.cut)
  if (existing !== undefined && existing.payload.kind !== options.kind) throw new ExperimentError('EXPERIMENT_CONFLICT', 'report-kind-changed')
  if (existing !== undefined) {
    const prior = experimentObject(await readExperimentArtifact(storage.location.controlRoot, existing.payload.report, plan.evidenceLimits.maxReportBytes), 'report')
    if (prior.numericMetrics === undefined || !Array.isArray(prior.numericMetrics)) throw new ExperimentError('EXPERIMENT_CONFLICT', 'report-metrics-missing')
    if (options.numericMetrics !== undefined && experimentJsonDigest(prior.numericMetrics) !== experimentJsonDigest(numericMetrics)) throw new ExperimentError('EXPERIMENT_CONFLICT', 'report-metrics-changed')
  }
  if (options.kind === 'primary' && state.activeUnit !== null) throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'primary-report-before-disposition')
  if (options.finalize === true && state.finalized === null && state.units.some(unit => unit.started === null) && options.unstartedReason === undefined) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'unstarted-disposition-required')
  const artifactFailures: { unitKey: string; reason: string; evidenceKey?: string }[] = [...results.artifactFailures]
  if (options.kind === 'posthoc') {
    const cut = existing?.payload.cut ?? results.cut
    for (const recorded of state.evidence.filter(recorded => recorded.stored.sequence <= cut)) {
      try {
        const evidence = decodeExperimentEvidence(await readExperimentArtifact(storage.location.controlRoot, recorded.payload.evidence, plan.evidenceLimits.maxEvidenceBytes), plan.evidenceLimits)
        if (experimentJsonDigest(evidence as unknown as JsonValue) !== recorded.payload.evidenceDigest) throw new ExperimentError('EXPERIMENT_CONFLICT', 'derived-evidence-digest')
        const reasons = await verifyExperimentEvidence(evidence, plan.evidenceLimits.maxEvidenceBytes)
        if (!evidence.coverage.complete || reasons.length > 0) {
          throw new ExperimentError('EXPERIMENT_EVIDENCE_INCOMPLETE', 'derived-source-incomplete')
        }
      } catch (cause) {
        if (!(cause instanceof ExperimentError) || cause.code !== 'EXPERIMENT_EVIDENCE_INCOMPLETE') throw cause
        artifactFailures.push({ unitKey: recorded.payload.unitKey, evidenceKey: recorded.payload.evidenceKey, reason: cause.message })
      }
    }
  }
  if (existing === undefined) {
    const selections = selectPrimaryExperimentEvaluations(results)
    const comparisons = plan.comparisons.map(comparison => compareExperimentResults({ results, comparisonKey: comparison.comparisonKey, numericMetrics }))
    const report = { version: 1, reportKey, kind: options.kind, experimentId: plan.experimentId, planDigest: plan.planDigest,
      datasetDigest: plan.dataset.datasetDigest, mode: plan.runPolicy.mode, journalCut: results.cut, selections,
      provenance: { userDeclared: plan.provenance, reportController: experimentControllerEnvironment(import.meta.url),
        recipes: state.units.flatMap(unit => unit.started === null ? [] : [{ unitKey: unit.unitKey, recipeDigest: unit.started.payload.recipeDigest, file: unit.started.payload.recipe }]) },
      numericMetrics, evaluations: state.evaluations, derivedEvidence: state.evidence,
      units: state.units, comparisons, observations: results.observations, artifactFailures,
      verification: { cloudApi: 'not-run-by-report', modelJudge: 'not-supported', pricing: 'not-measured', performance: 'local-monotonic-only' } }
    const reference = await publishExperimentArtifact(storage.location.controlRoot, `reports/${reportKey}-${experimentJsonDigest(report as unknown as JsonValue)}.json`, report as unknown as JsonValue, plan.evidenceLimits.maxReportBytes)
    event = await storage.journal.recordReport({ reportKey, kind: options.kind, report: reference, cut: results.cut,
      selections: selections as unknown as readonly JsonObject[] })
  }
  if (options.finalize === true && storage.journal.snapshot().finalized === null) {
    const unstarted = state.units.filter(unit => unit.started === null)
    if (unstarted.length > 0 && options.unstartedReason === undefined) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'unstarted-disposition-required')
    await storage.journal.finalize({ reportKey, unstarted: unstarted.map(unit => ({ unitKey: unit.unitKey, reason: options.unstartedReason! })) })
  }
  return { reference: event!.payload.report, cut: event!.payload.cut, selections: event!.payload.selections,
    finalized: storage.journal.snapshot().finalized !== null, state: storage.journal.snapshot(),
    complete: artifactFailures.length === 0, artifactFailures }
}

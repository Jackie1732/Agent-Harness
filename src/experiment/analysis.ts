import type { JsonObject, JsonValue } from '../foundation/json.js'
import { projectModelSession } from '../model/projection.js'
import type { ModelInvocationId } from '../model/ids.js'
import type { SessionId } from '../session/ids.js'
import type { ExperimentJournalSnapshot } from './journal-types.js'
import type { ComparisonNumericMetricName, ExperimentResultSet, ComparisonObservation } from './comparison-types.js'
import { compareExperimentResults, compareCrossExperimentResults } from './comparison.js'
import { readExperimentStorage, openExperimentStorage, readExperimentFile } from './storage.js'
import { join } from 'node:path'
import type { ExperimentStorage } from './storage.js'
import { readExperimentArtifact } from './artifacts.js'
import { decodeExperimentEvidence, decodeExperimentMeasurement } from './evidence-codec.js'
import { collectExperimentEvidence, verifyExperimentEvidence } from './evidence.js'
import { evaluateExperimentOutput } from './evaluation.js'
import { exportNormalizedCallFixture } from './fixture.js'
import { ExperimentError } from './errors.js'
import { experimentJsonDigest, experimentBytesDigest } from './parsing.js'

export { registerDerivedEvidence } from './derived-evidence.js'

/** Observe committed metadata without opening any Host or Writer. */
export const inspectExperiment = readExperimentStorage

/** Load only original sealed observations; posthoc records never replace them. */
export async function loadExperimentResultSet(root: string, state?: ExperimentJournalSnapshot, tolerateMissing = false): Promise<ExperimentResultSet & { readonly artifactFailures: readonly { unitKey: string; reason: string }[] }> {
  const journal = state ?? (await requireExperiment(root)).state
  const plan = journal.plan!
  const observations: ComparisonObservation[] = []
  const artifactFailures: { unitKey: string; reason: string }[] = []
  for (const unit of journal.units) {
    if (unit.sealed === null) continue
    try {
    const evidence = decodeExperimentEvidence(await readExperimentArtifact(root, unit.sealed.payload.evidence, plan.evidenceLimits.maxEvidenceBytes), plan.evidenceLimits)
    if (experimentJsonDigest(evidence as unknown as JsonValue) !== unit.sealed.payload.evidenceDigest) throw new ExperimentError('EXPERIMENT_CONFLICT', 'sealed-evidence-digest')
    if ((await verifyExperimentEvidence(evidence, plan.evidenceLimits.maxEvidenceBytes)).length > 0) throw new ExperimentError('EXPERIMENT_CONFLICT', 'sealed-source-changed')
    const reference = unit.sealed.payload.measurement
    const measurement = reference === null ? null : { reference, value: decodeExperimentMeasurement(await readExperimentArtifact(root, reference, plan.evidenceLimits.maxReportBytes)) }
    observations.push({ unitKey: unit.unitKey, evidenceDigest: unit.sealed.payload.evidenceDigest, metrics: evidence.metrics, measurement })
    } catch (cause) {
      if (!tolerateMissing) throw cause
      artifactFailures.push({ unitKey: unit.unitKey, reason: cause instanceof ExperimentError ? cause.message : 'artifact-unreadable' })
    }
  }
  return { plan, journal, cut: journal.position, observations, artifactFailures }
}

/** Compare compatible frozen observations without writing a report or changing model logs. */
export async function compareExperiments(root: string, options: { readonly comparisonKey: string; readonly otherRoot?: string;
  readonly variantA?: string; readonly variantB?: string; readonly numericMetrics?: readonly ComparisonNumericMetricName[] }) {
  const a = await loadExperimentResultSet(root)
  const numericMetrics = options.numericMetrics ?? []
  if (options.otherRoot === undefined) return compareExperimentResults({ results: a, comparisonKey: options.comparisonKey, numericMetrics })
  if (options.variantA === undefined || options.variantB === undefined) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'cross-comparison-variants-required')
  const b = await loadExperimentResultSet(options.otherRoot)
  return compareCrossExperimentResults({ a, b, variantA: options.variantA, variantB: options.variantB, comparisonKey: options.comparisonKey, numericMetrics })
}

/** Evaluate authenticated output with a declared rule set under metadata ownership. */
export async function evaluateExperiment(root: string, options: { readonly unitKey: string; readonly evaluatorKey?: string; readonly evidenceKey?: string }) {
  const storage = await openExperimentStorage(root)
  try { return await evaluateStoredExperimentUnit(storage, options) }
  finally { await storage.dispose() }
}

/** Runner and explicit evaluation share the same exact evidence/evaluator idempotency key. */
export async function evaluateStoredExperimentUnit(storage: ExperimentStorage,
  options: { readonly unitKey: string; readonly evaluatorKey?: string; readonly evidenceKey?: string }) {
  const state = storage.journal.snapshot(), plan = state.plan!
  const unit = state.units.find(unit => unit.unitKey === options.unitKey)
  const planned = plan.units.find(unit => unit.unitKey === options.unitKey)
  if (unit === undefined || planned === undefined) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'unit-not-planned')
  const derived = options.evidenceKey === undefined ? undefined : state.evidence.find(event => event.payload.evidenceKey === options.evidenceKey && event.payload.unitKey === options.unitKey)
  const reference = options.evidenceKey === undefined ? unit.sealed?.payload.evidence : derived?.payload.evidence
  const evidenceDigest = options.evidenceKey === undefined ? unit.sealed?.payload.evidenceDigest : derived?.payload.evidenceDigest
  if (reference === undefined || evidenceDigest === undefined) throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'evaluation-evidence-not-recorded')
  const item = plan.dataset.cases.find(item => item.caseKey === planned.caseKey)!
  const evaluator = plan.evaluators.find(evaluator => evaluator.evaluatorKey === (options.evaluatorKey ?? item.primaryEvaluatorKey))
  if (evaluator === undefined) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'evaluator-not-declared')
  const evidence = decodeExperimentEvidence(await readExperimentArtifact(storage.location.controlRoot, reference, plan.evidenceLimits.maxEvidenceBytes), plan.evidenceLimits)
  if (experimentJsonDigest(evidence as unknown as JsonValue) !== evidenceDigest) throw new ExperimentError('EXPERIMENT_CONFLICT', 'evaluation-evidence-digest')
  if ((await verifyExperimentEvidence(evidence, plan.evidenceLimits.maxEvidenceBytes)).length > 0) throw new ExperimentError('EXPERIMENT_CONFLICT', 'evaluation-source-changed')
  const result = evaluateExperimentOutput({ unitKey: unit.unitKey, case: item, evaluator, evidenceDigest, output: evidence.output, maxJsonBytes: plan.evidenceLimits.maxEvidenceBytes })
  await storage.journal.settleEvaluation({ unitKey: unit.unitKey, evidenceDigest, evaluatorDigest: result.evaluatorDigest,
    evaluatorVersion: evaluator.version, result: result as unknown as JsonObject })
  return result
}

/** Authenticate all referenced artifacts and original framed files, preserving independent coverage failures. */
export async function verifyExperiment(root: string) {
  const read = await readExperimentStorage(root)
  if (read.kind === 'uninitialized') return { version: 1, complete: false, reasons: ['experiment-uninitialized'], files: [] }
  const plan = read.state.plan!, files: { path: string; verified: boolean; reasons: readonly string[] }[] = []
  for (const item of plan.dataset.cases) for (const material of item.materials) {
    const path = `inputs/${item.caseKey}/${material.logicalPath}`
    let reasons: readonly string[] = []
    try {
      const bytes = await readExperimentFile(join(root, path), plan.evidenceLimits.maxInputBytes)
      if (bytes.byteLength !== material.byteLength || experimentBytesDigest(bytes) !== material.sha256) reasons = ['frozen-input-changed']
    } catch (cause) { reasons = [cause instanceof ExperimentError ? cause.message : 'frozen-input-unreadable'] }
    files.push({ path, verified: reasons.length === 0, reasons })
  }
  const references = read.state.units.flatMap(unit => [unit.started?.payload.recipe, unit.sealed?.payload.evidence,
    unit.unresolved?.payload.evidence, unit.sealed?.payload.measurement].filter(value => value !== undefined && value !== null))
  references.push(...read.state.evidence.map(event => event.payload.evidence), ...read.state.reports.map(event => event.payload.report))
  for (const reference of references) {
    let reasons: readonly string[] = []
    try {
      const raw = await readExperimentArtifact(root, reference, Math.max(plan.evidenceLimits.maxRecipeBytes, plan.evidenceLimits.maxEvidenceBytes, plan.evidenceLimits.maxReportBytes))
      if (reference.path.endsWith('/evidence.json') || read.state.evidence.some(event => event.payload.evidence.path === reference.path)) {
        const evidence = decodeExperimentEvidence(raw, plan.evidenceLimits)
        reasons = [...evidence.coverage.reasons, ...await verifyExperimentEvidence(evidence, plan.evidenceLimits.maxEvidenceBytes)]
      }
    } catch (cause) { reasons = [cause instanceof ExperimentError ? cause.message : 'artifact-unreadable'] }
    files.push({ path: reference.path, verified: reasons.length === 0, reasons })
  }
  const unresolved = read.state.units.some(unit => unit.unresolved !== null || unit.started !== null && unit.sealed === null)
  return { version: 1, complete: !unresolved && read.state.finalized !== null && files.every(item => item.verified),
    reasons: [...(unresolved ? ['unit-unresolved'] : []), ...(read.state.finalized === null ? ['experiment-not-finalized'] : [])], files }
}

/** Export normalized text calls from original verified cuts, never rerunning their providers. */
export async function exportExperimentFixture(root: string, options: { readonly unitKey: string; readonly sessionId: SessionId; readonly invocationIds?: readonly ModelInvocationId[] }) {
  const { state } = await requireExperiment(root), plan = state.plan!
  const unit = state.units.find(unit => unit.unitKey === options.unitKey)
  if (unit?.sealed === null || unit?.sealed === undefined) throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'fixture-unit-not-sealed')
  const evidence = decodeExperimentEvidence(await readExperimentArtifact(root, unit.sealed.payload.evidence, plan.evidenceLimits.maxEvidenceBytes), plan.evidenceLimits)
  if ((await verifyExperimentEvidence(evidence, plan.evidenceLimits.maxEvidenceBytes)).length > 0) throw new ExperimentError('EXPERIMENT_CONFLICT', 'fixture-source-changed')
  const selected = evidence.selections.find(item => item.sessionId === options.sessionId)
  if (selected?.through === null || selected?.through === undefined) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'fixture-session-not-selected')
  const recipe = plan.units.find(item => item.unitKey === unit.unitKey)!.recipe
  const collected = await collectExperimentEvidence({ recipe, limits: plan.evidenceLimits, scope: evidence.scope, mode: evidence.mode,
    selected: [{ sessionId: options.sessionId, through: selected.through }] })
  const snapshot = collected.snapshots.find(item => item.header.sessionId === options.sessionId), source = collected.evidence.sessions.find(item => item.sessionId === options.sessionId)
  if (!collected.evidence.coverage.complete || snapshot === undefined || source === undefined) throw new ExperimentError('EXPERIMENT_EVIDENCE_INCOMPLETE', 'fixture-cut-unreadable')
  return exportNormalizedCallFixture({ snapshot, source, invocationIds: options.invocationIds ?? projectModelSession(snapshot).invocations.map(item => item.invocationId), limits: plan.evidenceLimits })
}

async function requireExperiment(root: string) {
  const read = await readExperimentStorage(root)
  if (read.kind !== 'initialized') throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'experiment-uninitialized')
  return read
}

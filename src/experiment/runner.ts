import type { JsonValue } from '../foundation/json.js'
import { publishExperimentArtifact } from './artifacts.js'
import { evaluateStoredExperimentUnit } from './analysis.js'
import { recordExperimentReport } from './report.js'
import { createExperimentStorage, openExperimentStorage, readExperimentStorage } from './storage.js'
import { experimentJsonDigest } from './parsing.js'
import type { ExperimentPlan, ExperimentUnit } from './definition-types.js'
import type { ExperimentFileRef } from './definition-types.js'
import { runExperimentUnit } from './runner-unit.js'
import type { ExperimentRunResult, RunExperimentInput, RunExperimentOptions } from './runner-types.js'
import { ExperimentError } from './errors.js'

/** Execute a frozen matrix serially; continuation admits only units never previously started. */
export async function runExperiment(input: RunExperimentInput, options: RunExperimentOptions = {}): Promise<ExperimentRunResult> {
  const root = typeof input === 'string' ? input : 'units' in input ? input.storage.controlRoot : input.controlRoot
  const read = await readExperimentStorage(root)
  const supplied = typeof input !== 'string' && 'units' in input ? input : null
  const plan = supplied ?? read.state?.plan
  if (plan === undefined || plan === null) throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'experiment-uninitialized')
  if (read.kind === 'initialized') {
    if (options.continueUnstarted !== true) throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'explicit-continuation-required')
    if (read.state.plan!.planDigest !== plan.planDigest) throw new ExperimentError('EXPERIMENT_CONFLICT', 'continuation-plan-changed')
    requireContinuable(read.state)
  }
  if (read.kind === 'uninitialized') preflightRuntime(plan, options, plan.units)
  const storage = read.kind === 'initialized' ? await openExperimentStorage(root, options) : await createExperimentStorage(plan)
  let stoppedBy: ExperimentRunResult['stoppedBy'] = 'completed'
  try {
    const current = storage.journal.snapshot()
    if (read.kind === 'initialized') requireContinuable(current)
    const prior = current.units.filter(unit => unit.sealed !== null)
    const lastOutcome = prior.at(-1)?.sealed?.payload.outcome
    if (lastOutcome === 'cancelled') stoppedBy = 'cancelled'
    else if (lastOutcome !== undefined && plan.runPolicy.onCaseFailure === 'stop' && ['failed', 'result-unknown', 'timed-out'].includes(lastOutcome)) stoppedBy = 'policy'
    if (read.kind === 'initialized') preflightRuntime(plan, options, stoppedBy === 'completed' && !options.signal?.aborted
      ? plan.units.filter(unit => current.units.find(item => item.unitKey === unit.unitKey)!.started === null) : [])
    for (const unit of prior) await evaluateStoredExperimentUnit(storage, { unitKey: unit.unitKey })
    for (const unit of plan.units) {
      if (stoppedBy !== 'completed') break
      if (storage.journal.snapshot().units.find(item => item.unitKey === unit.unitKey)!.started !== null) continue
      if (options.signal?.aborted) { stoppedBy = 'cancelled'; break }
      const result = await runExperimentUnit(plan, unit, storage, options)
      let measurement: ExperimentFileRef
      let evidence: ExperimentFileRef | null = null
      try {
        measurement = await publishExperimentArtifact(root, `runs/${unit.unitKey}/measurement.json`, result.measurement as unknown as JsonValue, plan.evidenceLimits.maxReportBytes)
        evidence = result.evidence === null ? null : await publishExperimentArtifact(root, `runs/${unit.unitKey}/evidence.json`, result.evidence as unknown as JsonValue, plan.evidenceLimits.maxEvidenceBytes)
      } catch {
        await storage.journal.unresolveUnit({ unitKey: unit.unitKey, outcome: result.outcome, reason: 'artifact-publication-failed', closure: result.closure, evidence })
        stoppedBy = 'unresolved'; break
      }
      if (result.closure !== 'confirmed' || evidence === null || result.evidence?.coverage.complete !== true) {
        await storage.journal.unresolveUnit({ unitKey: unit.unitKey, outcome: result.outcome, reason: result.reason,
          closure: result.closure, evidence })
        stoppedBy = 'unresolved'; break
      }
      await storage.journal.sealUnit({ unitKey: unit.unitKey, outcome: result.outcome, reason: result.reason, closure: 'confirmed',
        evidenceDigest: experimentJsonDigest(result.evidence as unknown as JsonValue), evidence, measurement })
      await evaluateStoredExperimentUnit(storage, { unitKey: unit.unitKey })
      if (options.signal?.aborted || result.outcome === 'cancelled') { stoppedBy = 'cancelled'; break }
      if (plan.runPolicy.onCaseFailure === 'stop' && ['failed', 'result-unknown', 'timed-out'].includes(result.outcome)) { stoppedBy = 'policy'; break }
    }
    await recordExperimentReport(storage, { reportKey: 'primary', kind: 'primary', finalize: true,
      unstartedReason: stoppedBy === 'cancelled' ? 'cancelled-before-start' : stoppedBy === 'unresolved' ? 'not-run-after-interruption' : 'skipped-by-policy' })
    return { version: 1, location: storage.location, planDigest: plan.planDigest, finalized: true, units: storage.journal.snapshot().units, stoppedBy }
  } finally { await storage.dispose() }
}

function requireContinuable(state: import('./journal-types.js').ExperimentJournalSnapshot): void {
  if (state.finalized !== null || state.activeUnit !== null || state.units.some(unit => unit.unresolved !== null || unit.notRun !== null)
    || state.reports.some(report => report.payload.kind === 'primary')) throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'experiment-cannot-continue')
}
function preflightRuntime(plan: ExperimentPlan, options: RunExperimentOptions, units: readonly ExperimentUnit[]): void {
  if (options.mode !== undefined && options.mode !== plan.runPolicy.mode) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'run-mode-plan-mismatch')
  const requiredVariants = new Set(units.map(unit => unit.variantKey))
  for (const variant of plan.variants) {
    if (!requiredVariants.has(variant.variantKey)) continue
    if (variant.fixture.kind === 'programmatic' && options.fixtureBindings?.[variant.fixture.fixtureKey] === undefined) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'fixture-binding-missing')
    if (plan.runPolicy.mode === 'live') {
      const models = variant.recipe.members.flatMap(member => member.kind === 'local' ? [member.model] : [])
      if (variant.recipe.schemaVersion !== 1 && variant.recipe.subagents.kind === 'enabled') models.push(...variant.recipe.subagents.templates.map(template => template.model))
      for (const model of models) if (model.kind !== 'scripted-fixed' && !options.credentials?.[model.credentialRef]?.trim()) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'credential-reference-unavailable')
    }
  }
}

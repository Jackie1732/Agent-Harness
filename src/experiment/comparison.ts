import { snapshotJson } from '../foundation/json.js'
import { formatSessionEventId, parseSessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import type { ExperimentUnit, FrozenExperimentCase } from './definition-types.js'
import { decodeExperimentEvaluation } from './evaluation.js'
import type { ExperimentEvaluationResult } from './evaluation-types.js'
import { ExperimentError } from './errors.js'
import type { ExperimentEvaluationSettled } from './journal-types.js'
import type { CompareCrossExperimentResultsInput, CompareExperimentResultsInput, ComparisonArmSummary, ComparisonEvaluationSelection,
  ComparisonNumericMetricName, ComparisonNumericSummary, ComparisonObservation, ComparisonRowObservation, ExperimentComparison,
  ExperimentComparisonRow, ExperimentResultSet, NumericStatistics } from './comparison-types.js'
import type { ExperimentCountMetricName, ModelUsageField } from './metrics-types.js'
import { experimentKeys, experimentObject, experimentText } from './parsing.js'

interface SelectionSet { readonly status: 'primary-fixed' | 'provisional'; readonly cut: number; readonly selections: readonly ComparisonEvaluationSelection[] }
function invalid(reason: string): never { throw new ExperimentError('EXPERIMENT_STATE_INVALID', reason) }

/** Compare the two variants of one declared Plan comparison at the supplied Journal cut. */
export function compareExperimentResults(input: CompareExperimentResultsInput): ExperimentComparison {
  const comparison = input.results.plan.comparisons.find(item => item.comparisonKey === input.comparisonKey)
  if (comparison === undefined) invalid('comparison-not-planned')
  return compare({ a: input.results, b: input.results, variantA: comparison.variantA, variantB: comparison.variantB,
    comparisonKey: input.comparisonKey, numericMetrics: input.numericMetrics })
}

/** Compare compatible frozen Case/repetition matrices across distinct experiment namespaces. */
export function compareCrossExperimentResults(input: CompareCrossExperimentResultsInput): ExperimentComparison {
  const a = input.a.plan, b = input.b.plan
  if (a.dataset.datasetDigest !== b.dataset.datasetDigest || a.repetitions !== b.repetitions || a.dataset.cases.length !== b.dataset.cases.length
    || a.runPolicy.mode !== b.runPolicy.mode) invalid('comparison-incompatible-dataset-or-mode')
  for (const item of a.dataset.cases) {
    const other = b.dataset.cases.find(entry => entry.caseKey === item.caseKey)
    if (other === undefined || item.caseDigest !== other.caseDigest || item.evaluatorDigest !== other.evaluatorDigest
      || item.primaryEvaluatorKey !== other.primaryEvaluatorKey || item.output.outputKey !== other.output.outputKey) invalid('comparison-incompatible-case-or-evaluator')
    const evaluatorA = a.evaluators.find(entry => entry.evaluatorKey === item.primaryEvaluatorKey)!
    const evaluatorB = b.evaluators.find(entry => entry.evaluatorKey === other.primaryEvaluatorKey)!
    if (evaluatorA.version !== evaluatorB.version || evaluatorA.implementationVersion !== evaluatorB.implementationVersion) invalid('comparison-incompatible-evaluator-version')
  }
  return compare(input)
}

/** Freeze exact primary evaluation identities, or explicit missing entries, for every planned unit. */
export function selectPrimaryExperimentEvaluations(results: ExperimentResultSet): readonly ComparisonEvaluationSelection[] {
  validateResultSet(results)
  return selectionSet(results).selections
}

function validateResultSet(results: ExperimentResultSet): void {
  if (results.cut !== results.journal.position || results.journal.plan?.planDigest !== results.plan.planDigest
    || results.journal.plan.experimentId !== results.plan.experimentId) invalid('comparison-journal-cut-or-plan')
  if (new Set(results.observations.map(item => item.unitKey)).size !== results.observations.length) invalid('comparison-duplicate-observation')
  for (const observation of results.observations) {
    const unit = results.journal.units.find(item => item.unitKey === observation.unitKey)
    if (unit?.sealed === null || unit?.sealed === undefined || unit.sealed.payload.evidenceDigest !== observation.evidenceDigest) invalid('comparison-observation-not-original-sealed')
    if (observation.measurement !== null && (observation.measurement.value.unitKey !== observation.unitKey || unit.sealed.payload.measurement === null
      || unit.sealed.payload.measurement.path !== observation.measurement.reference.path
      || unit.sealed.payload.measurement.sha256 !== observation.measurement.reference.sha256
      || unit.sealed.payload.measurement.byteLength !== observation.measurement.reference.byteLength)) invalid('comparison-measurement-not-original-sealed')
  }
}

function selectionSet(results: ExperimentResultSet): SelectionSet {
  const { plan, journal } = results
  if (journal.finalized !== null) {
    const report = journal.reports.find(item => item.payload.reportKey === journal.finalized!.payload.reportKey && item.payload.kind === 'primary')
    if (report === undefined) invalid('comparison-primary-report-missing')
    const selections = report.payload.selections.map(value => {
      const raw = experimentObject(value, 'primary-selection'); experimentKeys(raw, ['unitKey', 'evaluationEvent'], 'primary-selection')
      let evaluationEvent: WorkflowEventRef | null = null
      if (raw.evaluationEvent !== null) {
        const event = experimentObject(raw.evaluationEvent, 'primary-ref'); experimentKeys(event, ['address', 'eventId'], 'primary-ref')
        const parsed = parseSessionEventId(experimentText(event.eventId, 'primary-eventId', 80))
        if (event.address !== plan.experimentId || parsed.sessionId !== plan.journalSessionId) invalid('comparison-primary-ref-namespace')
        evaluationEvent = { address: plan.experimentId, eventId: formatSessionEventId(parsed.sessionId, parsed.sequence) }
      }
      return { unitKey: experimentText(raw.unitKey, 'primary-unitKey', 128), evaluationEvent }
    })
    if (selections.length !== plan.units.length || new Set(selections.map(item => item.unitKey)).size !== plan.units.length
      || selections.some(item => !plan.units.some(unit => unit.unitKey === item.unitKey))) invalid('comparison-primary-selection-matrix')
    for (const selection of selections) {
      if (selection.evaluationEvent !== null) {
        const unit = plan.units.find(item => item.unitKey === selection.unitKey)!
        const evaluation = journal.evaluations.find(item => sameRef(ref(plan.experimentId, item), selection.evaluationEvent!))
        if (evaluation === undefined || evaluation.stored.sequence > report.payload.cut || !isPrimary(results, unit, evaluation)) invalid('comparison-primary-evaluation-ref')
      }
    }
    return { status: 'primary-fixed', cut: report.payload.cut, selections }
  }
  return { status: 'provisional', cut: results.cut, selections: plan.units.map(unit => {
    const eligible = journal.evaluations.filter(event => event.stored.sequence <= results.cut && isPrimary(results, unit, event))
    if (eligible.length > 1) invalid('comparison-primary-evaluation-ambiguous')
    return { unitKey: unit.unitKey, evaluationEvent: eligible.length === 0 ? null : ref(plan.experimentId, eligible[0]!) }
  }) }
}

function isPrimary(results: ExperimentResultSet, unit: ExperimentUnit, event: CommittedSessionEvent<ExperimentEvaluationSettled>): boolean {
  const item = results.plan.dataset.cases.find(item => item.caseKey === unit.caseKey)!
  const evaluator = results.plan.evaluators.find(entry => entry.evaluatorKey === item.primaryEvaluatorKey)!
  const sealed = results.journal.units.find(entry => entry.unitKey === unit.unitKey)?.sealed
  return sealed !== null && sealed !== undefined && event.stored.sessionId === results.plan.journalSessionId
    && event.payload.unitKey === unit.unitKey && event.payload.evidenceDigest === sealed.payload.evidenceDigest
    && event.payload.evaluatorDigest === item.evaluatorDigest && event.payload.evaluatorVersion === evaluator.version
}

function compare(input: CompareCrossExperimentResultsInput): ExperimentComparison {
  validateResultSet(input.a); if (input.b !== input.a) validateResultSet(input.b)
  const variantA = input.a.plan.variants.find(item => item.variantKey === input.variantA), variantB = input.b.plan.variants.find(item => item.variantKey === input.variantB)
  if (variantA === undefined || variantB === undefined) invalid('comparison-variant-not-planned')
  const selectionA = selectionSet(input.a), selectionB = input.b === input.a ? selectionA : selectionSet(input.b)
  const rows: ExperimentComparisonRow[] = []
  for (const item of input.a.plan.dataset.cases) for (let repetition = 1; repetition <= input.a.plan.repetitions; repetition++) {
    const unitA = input.a.plan.units.find(unit => unit.caseKey === item.caseKey && unit.repetition === repetition && unit.variantKey === input.variantA)
    const unitB = input.b.plan.units.find(unit => unit.caseKey === item.caseKey && unit.repetition === repetition && unit.variantKey === input.variantB)
    if (unitA === undefined || unitB === undefined) invalid('comparison-observation-matrix')
    rows.push({ caseKey: item.caseKey, repetition, a: rowArm(input.a, unitA, selectionA, input.numericMetrics), b: rowArm(input.b, unitB, selectionB, input.numericMetrics) })
  }
  const qualityCross = { bothPass: 0, aPassBFail: 0, aFailBPass: 0, bothFail: 0, missing: 0 }
  for (const row of rows) {
    const a = row.a.evaluation.status, b = row.b.evaluation.status
    if (a === 'pass' && b === 'pass') qualityCross.bothPass++
    else if (a === 'pass' && b === 'fail') qualityCross.aPassBFail++
    else if (a === 'fail' && b === 'pass') qualityCross.aFailBPass++
    else if (a === 'fail' && b === 'fail') qualityCross.bothFail++
    else qualityCross.missing++
  }
  const arm = (side: 'A' | 'B', results: ExperimentResultSet, variant: typeof variantA, selection: SelectionSet) => ({ side,
    experimentId: results.plan.experimentId, variantKey: variant.variantKey, factors: variant.factors,
    journalCut: results.cut, selectionCut: selection.cut, selectionStatus: selection.status })
  return snapshotJson({ version: 1, comparisonKey: input.comparisonKey, definitionVersion: 'paired-description/v1',
    status: selectionA.status === 'primary-fixed' && selectionB.status === 'primary-fixed' ? 'primary-fixed' : 'provisional',
    datasetDigest: input.a.plan.dataset.datasetDigest, mode: input.a.plan.runPolicy.mode,
    arms: [arm('A', input.a, variantA, selectionA), arm('B', input.b, variantB, selectionB)], rows,
    summary: { a: summarizeArm(rows.map(row => row.a)), b: summarizeArm(rows.map(row => row.b)), qualityCross },
    numeric: input.numericMetrics.map(metric => summarizeMetric(metric, rows, input.a.plan.dataset.cases)) }) as unknown as ExperimentComparison
}

function rowArm(results: ExperimentResultSet, unit: ExperimentUnit, selection: SelectionSet, names: readonly ComparisonNumericMetricName[]): ComparisonRowObservation {
  const latest = results.journal.units.find(item => item.unitKey === unit.unitKey)!
  const state = { ...latest, started: latest.started !== null && latest.started.stored.sequence <= selection.cut ? latest.started : null,
    sealed: latest.sealed !== null && latest.sealed.stored.sequence <= selection.cut ? latest.sealed : null,
    unresolved: latest.unresolved !== null && latest.unresolved.stored.sequence <= selection.cut ? latest.unresolved : null }
  const disposition = state.sealed !== null ? 'sealed' : state.unresolved !== null ? 'unresolved' : state.started !== null ? 'running' : 'not-started'
  const eventRef = selection.selections.find(item => item.unitKey === unit.unitKey)!.evaluationEvent
  let evaluated: ExperimentEvaluationResult | null = null
  if (eventRef !== null) {
    const event = results.journal.evaluations.find(item => sameRef(ref(results.plan.experimentId, item), eventRef))!
    evaluated = decodeExperimentEvaluation(event.payload.result, results.plan.evidenceLimits.maxReportBytes)
    const item = results.plan.dataset.cases.find(item => item.caseKey === unit.caseKey)!
    const evaluator = results.plan.evaluators.find(entry => entry.evaluatorKey === item.primaryEvaluatorKey)!
    if (evaluated.unitKey !== unit.unitKey || evaluated.evidenceDigest !== event.payload.evidenceDigest || evaluated.evaluatorDigest !== item.evaluatorDigest
      || evaluated.evaluatorKey !== item.primaryEvaluatorKey || evaluated.evaluatorVersion !== evaluator.version
      || evaluated.outputKey !== item.output.outputKey || evaluated.implementationVersion !== evaluator.implementationVersion) invalid('comparison-evaluation-result-identity')
  }
  const observation = state.sealed === null ? undefined : results.observations.find(item => item.unitKey === unit.unitKey)
  const values = names.map(name => ({ name, ...numericValue(name, observation, results.plan.runPolicy.mode) }))
  return { experimentId: results.plan.experimentId, unitKey: unit.unitKey, disposition,
    business: state.sealed?.payload.outcome ?? state.unresolved?.payload.outcome ?? (state.started === null ? 'not-started' : 'running'),
    reason: state.sealed?.payload.reason ?? state.unresolved?.payload.reason ?? state.notRun, notRun: state.notRun,
    sealedEvent: state.sealed === null ? null : ref(results.plan.experimentId, state.sealed), evidenceDigest: state.sealed?.payload.evidenceDigest ?? null,
    evaluation: { status: evaluated?.overall ?? 'not-evaluated', score: evaluated?.score ?? null, event: eventRef },
    numeric: Object.fromEntries(values.map(item => [item.name, item.value])), knownNumeric: Object.fromEntries(values.map(item => [item.name, item.knownSubtotal])),
    numericReasons: Object.fromEntries(values.map(item => [item.name, item.reason])) }
}

function numericValue(name: ComparisonNumericMetricName, observation: ComparisonObservation | undefined, mode: 'fixture' | 'live') {
  if (observation === undefined) return { value: null, knownSubtotal: 0, reason: 'original-evidence-unavailable' }
  if (name.startsWith('time.')) {
    const measurement = observation.measurement?.value
    if (measurement === undefined) return { value: null, knownSubtotal: 0, reason: 'measurement-unavailable' }
    const value = measurement[name.slice(5) as 'initMs' | 'driveMs' | 'shutdownMs' | 'totalMs']
    return { value, knownSubtotal: value ?? 0, reason: value === null ? 'measurement-unavailable' : null }
  }
  const metrics = observation.metrics
  if (metrics === null || metrics.scope !== 'unit-local/v1' || metrics.mode !== mode) return { value: null, knownSubtotal: 0, reason: 'unit-metrics-unavailable' }
  const metric = name.startsWith('token.') ? metrics.tokens[name.slice(6) as ModelUsageField] : metrics.counts[name.slice(6) as ExperimentCountMetricName]
  const value = 'total' in metric ? metric.total : metric.value
  return { value, knownSubtotal: metric.knownSubtotal, reason: value === null ? 'metric-incomplete' : null }
}

function summarizeArm(rows: readonly ComparisonRowObservation[]): ComparisonArmSummary {
  const qualityCounts = { pass: 0, fail: 0, unavailable: 0, error: 0, 'not-evaluated': 0 }, businessCounts: Record<string, number> = {}
  const notRunCounts = { 'skipped-by-policy': 0, 'cancelled-before-start': 0, 'not-run-after-interruption': 0 }
  for (const row of rows) { qualityCounts[row.evaluation.status]++; businessCounts[row.business] = (businessCounts[row.business] ?? 0) + 1; if (row.notRun !== null) notRunCounts[row.notRun]++ }
  const planned = rows.length, started = rows.filter(row => row.disposition !== 'not-started').length, sealed = rows.filter(row => row.disposition === 'sealed').length
  const unresolved = rows.filter(row => row.disposition === 'unresolved').length, completed = rows.filter(row => row.disposition === 'sealed' && row.business === 'completed').length
  const evaluated = qualityCounts.pass + qualityCounts.fail
  return { planned, started, sealed, unresolved, notStarted: planned - started, completed, businessCounts, notRunCounts, qualityCounts,
    plannedPassRate: qualityCounts.pass / planned, evaluatedPassRate: evaluated > 0 ? qualityCounts.pass / evaluated : null,
    evaluationCoverage: evaluated / planned, completedRate: completed / planned, sealedCoverage: sealed / planned }
}

function summarizeMetric(metric: ComparisonNumericMetricName, rows: readonly ExperimentComparisonRow[], cases: readonly FrozenExperimentCase[]): ComparisonNumericSummary {
  const entries = cases.map(item => {
    const repeats = rows.filter(row => row.caseKey === item.caseKey)
    const valuesA = repeats.flatMap(row => row.a.numeric[metric] === null ? [] : [row.a.numeric[metric]!])
    const valuesB = repeats.flatMap(row => row.b.numeric[metric] === null ? [] : [row.b.numeric[metric]!])
    const pairs = repeats.flatMap(row => row.a.numeric[metric] === null || row.b.numeric[metric] === null ? [] : [row.b.numeric[metric]! - row.a.numeric[metric]!])
    return { caseKey: item.caseKey, plannedRepetitions: repeats.length, missingA: repeats.length - valuesA.length, missingB: repeats.length - valuesB.length,
      missingPairs: repeats.length - pairs.length, a: { ...stats(valuesA), knownSubtotal: repeats.reduce((sum, row) => sum + row.a.knownNumeric[metric]!, 0) },
      b: { ...stats(valuesB), knownSubtotal: repeats.reduce((sum, row) => sum + row.b.knownNumeric[metric]!, 0) }, delta: stats(pairs) }
  })
  const balanced = (side: 'a' | 'b' | 'delta') => {
    const means = entries.flatMap(item => item[side].mean === null ? [] : [item[side].mean!])
    return { validCases: means.length, missingCases: cases.length - means.length, mean: stats(means).mean }
  }
  const values = (side: 'a' | 'b') => rows.flatMap(row => row[side].numeric[metric] === null ? [] : [row[side].numeric[metric]!])
  const deltas = rows.flatMap(row => row.a.numeric[metric] === null || row.b.numeric[metric] === null ? [] : [row.b.numeric[metric]! - row.a.numeric[metric]!])
  const armStats = (side: 'a' | 'b') => ({ ...stats(values(side)), knownSubtotal: rows.reduce((sum, row) => sum + row[side].knownNumeric[metric]!, 0) })
  return { metric, a: { units: armStats('a'), caseBalanced: balanced('a') }, b: { units: armStats('b'), caseBalanced: balanced('b') },
    delta: { definition: 'B-A', completePairs: stats(deltas), caseBalanced: balanced('delta') }, cases: entries }
}

function stats(values: readonly number[]): NumericStatistics {
  let knownSubtotal = 0, min: number | null = null, max: number | null = null
  for (const value of values) { knownSubtotal += value; min = min === null ? value : Math.min(min, value); max = max === null ? value : Math.max(max, value) }
  return { count: values.length, knownSubtotal, mean: values.length > 0 ? knownSubtotal / values.length : null, min, max }
}
function ref(address: WorkflowEventRef['address'], event: CommittedSessionEvent): WorkflowEventRef {
  return { address, eventId: event.stored.eventId }
}
function sameRef(a: WorkflowEventRef, b: WorkflowEventRef): boolean { return a.address === b.address && a.eventId === b.eventId }

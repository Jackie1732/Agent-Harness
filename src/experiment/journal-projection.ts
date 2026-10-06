import type { JsonObject, JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import type { CommittedSessionEvent, SessionSnapshot } from '../session/types.js'
import type { ExperimentPlan } from './definition-types.js'
import type { ExperimentEventKind, ExperimentEventPayloads, ExperimentJournalSnapshot, ExperimentUnitState } from './journal-types.js'
import { ExperimentError } from './errors.js'

function invalid(reason: string): never { throw new ExperimentError('EXPERIMENT_STATE_INVALID', reason) }
const empty = (position = 0): ExperimentJournalSnapshot => ({ plan: null, units: [], evidence: [], evaluations: [], reports: [], finalized: null, activeUnit: null, position })

/** Apply one decoded experiment event; enforces original dispositions and posthoc-only finalization. */
export function applyExperimentJournalEvent<K extends ExperimentEventKind>(before: ExperimentJournalSnapshot, kind: K,
  event: CommittedSessionEvent<ExperimentEventPayloads[K]>): ExperimentJournalSnapshot {
  const payload = event.payload as ExperimentEventPayloads[ExperimentEventKind]
  if (before.finalized !== null && !['evidence-recorded', 'evaluation-settled', 'report-recorded'].includes(kind)) invalid('experiment-finalized')
  if (kind === 'plan-recorded') {
    if (before.plan !== null || before.position !== 0) invalid('duplicate-plan')
    const plan = (payload as ExperimentEventPayloads['plan-recorded']).plan as unknown as ExperimentPlan
    if (plan.journalSessionId !== event.stored.sessionId) invalid('journal-plan-identity')
    return { ...before, plan, position: event.stored.sequence,
      units: plan.units.map(unit => ({ unitKey: unit.unitKey, started: null, sealed: null, unresolved: null, notRun: null })) }
  }
  if (before.plan === null) invalid('plan-not-recorded')
  const unitKey = 'unitKey' in payload ? payload.unitKey : null
  const unit = before.units.find(unit => unit.unitKey === unitKey)
  if (unitKey !== null && unit === undefined) invalid('unit-not-planned')
  const update = (state: ExperimentUnitState): readonly ExperimentUnitState[] => before.units.map(unit => unit.unitKey === state.unitKey ? state : unit)
  const result = { ...before, position: event.stored.sequence }
  switch (kind) {
    case 'unit-started': {
      const started = event as CommittedSessionEvent<ExperimentEventPayloads['unit-started']>
      if (before.activeUnit !== null || unit!.started !== null || unit!.notRun !== null || before.units.some(unit => unit.unresolved !== null)) invalid('unit-start-not-admitted')
      if (before.reports.some(report => report.payload.kind === 'primary')) invalid('primary-report-frozen')
      const first = before.units.find(unit => unit.started === null && unit.notRun === null)
      if (first?.unitKey !== unitKey || before.plan.units.find(unit => unit.unitKey === unitKey)?.recipeDigest !== started.payload.templateDigest) invalid('unit-start-template-or-order')
      return { ...result, activeUnit: unit!.unitKey, units: update({ ...unit!, started }) }
    }
    case 'unit-sealed':
    case 'unit-unresolved': {
      if (before.activeUnit !== unitKey || unit!.started === null || unit!.sealed !== null || unit!.unresolved !== null) invalid('unit-disposition-not-admitted')
      const state = kind === 'unit-sealed' ? { ...unit!, sealed: event as CommittedSessionEvent<ExperimentEventPayloads['unit-sealed']> }
        : { ...unit!, unresolved: event as CommittedSessionEvent<ExperimentEventPayloads['unit-unresolved']> }
      return { ...result, activeUnit: null, units: update(state) }
    }
    case 'evidence-recorded': {
      const recorded = event as CommittedSessionEvent<ExperimentEventPayloads['evidence-recorded']>
      if (unit!.sealed === null && unit!.unresolved === null || before.evidence.some(item => item.payload.evidenceKey === recorded.payload.evidenceKey)) invalid('derived-evidence-not-admitted')
      const source = recorded.payload.derivedFrom, original = unit!.sealed ?? unit!.unresolved!
      const expected = original.payload.evidence, supplied = source.originalEvidence
      if (source.originalDisposition.address !== before.plan.experimentId || source.originalDisposition.eventId !== original.stored.eventId
        || source.recipeDigest !== unit!.started!.payload.recipeDigest || (supplied === null) !== (expected === null)
        || supplied !== null && expected !== null && (supplied.path !== expected.path || supplied.sha256 !== expected.sha256 || supplied.byteLength !== expected.byteLength)) invalid('derived-evidence-source')
      return { ...result, evidence: [...before.evidence, recorded] }
    }
    case 'evaluation-settled': {
      const evaluation = event as CommittedSessionEvent<ExperimentEventPayloads['evaluation-settled']>
      const evidenceDigest = evaluation.payload.evidenceDigest
      if (unit!.sealed?.payload.evidenceDigest !== evidenceDigest && !before.evidence.some(item => item.payload.unitKey === unitKey && item.payload.evidenceDigest === evidenceDigest)) invalid('evaluation-evidence-not-recorded')
      const key = experimentEventKey('evaluation-settled', evaluation.payload)
      if (before.evaluations.some(item => experimentEventKey('evaluation-settled', item.payload) === key)) invalid('duplicate-evaluation')
      return { ...result, evaluations: [...before.evaluations, evaluation] }
    }
    case 'report-recorded': {
      const report = event as CommittedSessionEvent<ExperimentEventPayloads['report-recorded']>
      if (report.payload.cut > before.position || before.reports.some(item => item.payload.reportKey === report.payload.reportKey)
        || before.finalized !== null && report.payload.kind !== 'posthoc') invalid('report-not-admitted')
      if (report.payload.kind === 'primary') {
        if (before.reports.some(report => report.payload.kind === 'primary')) invalid('primary-report-exists')
        if (before.activeUnit !== null || before.units.some(unit => {
          const disposition = unit.sealed ?? unit.unresolved
          return unit.started !== null && (disposition === null || disposition.stored.sequence > report.payload.cut)
        })) invalid('primary-report-before-disposition')
        const selections = report.payload.selections.map(selection => selection.unitKey)
        if (selections.length !== before.units.length || new Set(selections).size !== before.units.length
          || before.units.some(unit => !selections.includes(unit.unitKey))) invalid('primary-report-matrix')
        for (const selection of report.payload.selections) {
          const planned = before.plan.units.find(unit => unit.unitKey === selection.unitKey)!
          const observed = before.units.find(unit => unit.unitKey === selection.unitKey)!
          const item = before.plan.dataset.cases.find(item => item.caseKey === planned.caseKey)!
          const evaluator = before.plan.evaluators.find(evaluator => evaluator.evaluatorKey === item.primaryEvaluatorKey)!
          const eligible = before.evaluations.find(event => event.stored.sequence <= report.payload.cut && event.payload.unitKey === planned.unitKey
            && event.payload.evidenceDigest === observed.sealed?.payload.evidenceDigest && event.payload.evaluatorDigest === item.evaluatorDigest
            && event.payload.evaluatorVersion === evaluator.version)
          const reference = selection.evaluationEvent as JsonObject | null
          if (reference === null ? eligible !== undefined : eligible === undefined
            || reference.address !== before.plan.experimentId || reference.eventId !== eligible.stored.eventId) invalid('primary-report-evaluation-reference')
        }
      }
      return { ...result, reports: [...before.reports, report] }
    }
    case 'finalized': {
      const finalized = event as CommittedSessionEvent<ExperimentEventPayloads['finalized']>
      if (before.activeUnit !== null || !before.reports.some(item => item.payload.reportKey === finalized.payload.reportKey && item.payload.kind === 'primary')) invalid('finalize-active-or-report')
      const unstarted = finalized.payload.unstarted
      if (new Set(unstarted.map(unit => unit.unitKey)).size !== unstarted.length || unstarted.some(item => !before.units.some(unit => unit.unitKey === item.unitKey && unit.started === null))) invalid('finalize-unstarted')
      const units = before.units.map(unit => ({ ...unit, notRun: unit.started === null ? unstarted.find(item => item.unitKey === unit.unitKey)?.reason ?? null : unit.notRun }))
      if (units.some(unit => unit.started === null ? unit.notRun === null : unit.sealed === null && unit.unresolved === null)) invalid('finalize-incomplete-matrix')
      return { ...result, units, finalized }
    }
  }
  return invalid('unknown-experiment-event')
}

/** Stable domain key for an idempotent command; its payload must still compare exactly. */
export function experimentEventKey<K extends ExperimentEventKind>(kind: K, payload: ExperimentEventPayloads[K]): string {
  const value = payload as ExperimentEventPayloads[ExperimentEventKind]
  if (kind === 'plan-recorded' || kind === 'finalized') return kind
  if (kind === 'evaluation-settled') {
    const evaluation = value as ExperimentEventPayloads['evaluation-settled']
    return JSON.stringify([kind, evaluation.unitKey, evaluation.evidenceDigest, evaluation.evaluatorDigest, evaluation.evaluatorVersion])
  }
  if (kind === 'evidence-recorded') return JSON.stringify([kind, (value as ExperimentEventPayloads['evidence-recorded']).evidenceKey])
  if (kind === 'report-recorded') return JSON.stringify([kind, (value as ExperimentEventPayloads['report-recorded']).reportKey])
  return JSON.stringify([kind, (value as ExperimentEventPayloads['unit-started']).unitKey])
}

/** Pure reconstruction of a root Experiment Journal; never writes or opens a Provider. */
export function projectExperimentJournal(snapshot: SessionSnapshot): ExperimentJournalSnapshot {
  if (snapshot.history.length !== 1) invalid('experiment-journal-cannot-inherit')
  let state = empty()
  for (const event of snapshot.history[0]!.events) {
    if (event.kind === 'opaque') { state = { ...state, position: event.stored.sequence }; continue }
    if (!event.stored.type.startsWith('experiment/')) invalid('unexpected-journal-event')
    state = applyExperimentJournalEvent(state, event.stored.type.slice('experiment/'.length) as ExperimentEventKind,
      event as CommittedSessionEvent<ExperimentEventPayloads[ExperimentEventKind]>)
  }
  return snapshotJson(state as unknown as JsonValue) as unknown as ExperimentJournalSnapshot
}

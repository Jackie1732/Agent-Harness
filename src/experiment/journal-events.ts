import { createDurableEventCatalog, createDurableEventDefinition } from '../session/event-catalog.js'
import type { DurableEventDefinition } from '../session/event-catalog.js'
import { encodeStoredSessionEvent } from '../session/codec.js'
import { formatSessionAddress, formatSessionEventId, parseSessionAddress, parseSessionEventId, sessionSequence } from '../session/ids.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { ExperimentFileRef, ExperimentPlan } from './definition-types.js'
import type { ExperimentDerivedFrom, ExperimentEventKind, ExperimentEventPayloads } from './journal-types.js'
import { experimentArray as array, experimentChoice as choice, experimentDigest as digest, experimentInteger as integer,
  experimentKey as key, experimentKeys as exact, experimentObject as object, experimentRelativePath as path, experimentText as text, invalidExperiment as invalid } from './parsing.js'
import { decodeExperimentPlan } from './plan-codec.js'
import { ExperimentError } from './errors.js'

const outcome = ['completed', 'failed', 'result-unknown', 'cancelled', 'timed-out', 'interrupted'] as const
export function decodeExperimentFileRef(value: unknown): ExperimentFileRef {
  const item = object(value, 'file-reference'); exact(item, ['path', 'sha256', 'byteLength'], 'file-reference')
  return Object.freeze({ path: path(item.path, 'file-reference-path'), sha256: digest(item.sha256, 'file-reference-digest'), byteLength: integer(item.byteLength, 'file-reference-byteLength', 0) })
}
function decodeJournalEventRef(value: unknown) {
  const input = object(value, 'journal-reference'); exact(input, ['address', 'eventId'], 'journal-reference')
  const address = formatSessionAddress(parseSessionAddress(text(input.address, 'journal-reference-address', 64)))
  const parsed = parseSessionEventId(text(input.eventId, 'journal-reference-eventId', 96))
  if (formatSessionAddress(parsed.sessionId) !== address) invalid('journal-reference-session')
  return { address, eventId: formatSessionEventId(parsed.sessionId, parsed.sequence) }
}
/** Decode a bounded management source before any derived file is published. */
export function decodeExperimentDerivedFrom(value: unknown): ExperimentDerivedFrom {
  const item = object(value, 'derivedFrom')
  exact(item, ['kind', 'actionKey', 'originalDisposition', 'originalEvidence', 'recipeDigest', 'sourceRoot'], 'derivedFrom')
  if (item.kind !== 'reviewed-copy/v1') invalid('derivedFrom-kind')
  return Object.freeze({ kind: 'reviewed-copy/v1', actionKey: key(item.actionKey, 'actionKey'), originalDisposition: decodeJournalEventRef(item.originalDisposition),
    originalEvidence: item.originalEvidence === null ? null : decodeExperimentFileRef(item.originalEvidence), recipeDigest: digest(item.recipeDigest, 'derived-recipeDigest'),
    sourceRoot: text(item.sourceRoot, 'derived-sourceRoot') })
}
function decodePayload<K extends ExperimentEventKind>(kind: K, value: JsonValue): ExperimentEventPayloads[K] {
  const item = object(value, kind)
  switch (kind) {
    case 'plan-recorded': exact(item, ['plan'], kind); decodeExperimentPlan(item.plan); break
    case 'unit-started': exact(item, ['unitKey', 'templateDigest', 'recipeDigest', 'recipe'], kind); text(item.unitKey, 'unitKey', 128); digest(item.templateDigest, 'templateDigest'); digest(item.recipeDigest, 'recipeDigest'); decodeExperimentFileRef(item.recipe); break
    case 'unit-sealed':
      exact(item, ['unitKey', 'outcome', 'reason', 'closure', 'evidenceDigest', 'evidence', 'measurement'], kind)
      text(item.unitKey, 'unitKey', 128); choice(item.outcome, outcome, 'outcome'); text(item.reason, 'reason', 4096, true)
      choice(item.closure, ['confirmed'], 'closure'); digest(item.evidenceDigest, 'evidenceDigest'); decodeExperimentFileRef(item.evidence)
      if (item.measurement !== null) decodeExperimentFileRef(item.measurement)
      break
    case 'unit-unresolved':
      exact(item, ['unitKey', 'outcome', 'reason', 'closure', 'evidence'], kind)
      text(item.unitKey, 'unitKey', 128); choice(item.outcome, outcome, 'outcome'); text(item.reason, 'reason', 4096, true); choice(item.closure, ['confirmed', 'failed', 'unknown'], 'closure')
      if (item.evidence !== null) decodeExperimentFileRef(item.evidence)
      break
    case 'evidence-recorded':
      exact(item, ['unitKey', 'evidenceKey', 'evidenceDigest', 'evidence', 'derivedFrom'], kind)
      text(item.unitKey, 'unitKey', 128); key(item.evidenceKey, 'evidenceKey'); digest(item.evidenceDigest, 'evidenceDigest'); decodeExperimentFileRef(item.evidence); decodeExperimentDerivedFrom(item.derivedFrom); break
    case 'evaluation-settled':
      exact(item, ['unitKey', 'evidenceDigest', 'evaluatorDigest', 'evaluatorVersion', 'result'], kind)
      text(item.unitKey, 'unitKey', 128); digest(item.evidenceDigest, 'evidenceDigest'); digest(item.evaluatorDigest, 'evaluatorDigest'); text(item.evaluatorVersion, 'evaluatorVersion', 128); object(item.result, 'result'); break
    case 'report-recorded':
      exact(item, ['reportKey', 'kind', 'report', 'cut', 'selections'], kind)
      text(item.reportKey, 'reportKey', 128); choice(item.kind, ['primary', 'posthoc'], 'report-kind'); decodeExperimentFileRef(item.report)
      integer(item.cut, 'report-cut', 0); array(item.selections, 'report-selections').forEach(value => {
        const selection = object(value, 'report-selection'); exact(selection, ['unitKey', 'evaluationEvent'], 'report-selection')
        text(selection.unitKey, 'selection-unitKey', 128)
        if (selection.evaluationEvent !== null) {
          decodeJournalEventRef(selection.evaluationEvent)
        }
      }); break
    case 'finalized':
      exact(item, ['reportKey', 'unstarted'], kind); text(item.reportKey, 'reportKey', 128)
      array(item.unstarted, 'unstarted').forEach(value => {
        const unit = object(value, 'unstarted-unit'); exact(unit, ['unitKey', 'reason'], 'unstarted-unit'); text(unit.unitKey, 'unitKey', 128)
        choice(unit.reason, ['skipped-by-policy', 'cancelled-before-start', 'not-run-after-interruption'], 'unstarted-reason')
      }); break
  }
  return snapshotJson(item) as unknown as ExperimentEventPayloads[K]
}
function event<K extends ExperimentEventKind>(kind: K): DurableEventDefinition<ExperimentEventPayloads[K]> {
  return createDurableEventDefinition({ type: `experiment/${kind}`, payloadVersion: 1, ignorable: false, decode: value => decodePayload(kind, value) })
}
export const experimentEvents = Object.freeze({ 'plan-recorded': event('plan-recorded'), 'unit-started': event('unit-started'),
  'unit-sealed': event('unit-sealed'), 'unit-unresolved': event('unit-unresolved'), 'evidence-recorded': event('evidence-recorded'),
  'evaluation-settled': event('evaluation-settled'), 'report-recorded': event('report-recorded'), finalized: event('finalized') })
export const experimentEventCatalog = createDurableEventCatalog(Object.values(experimentEvents))

/** Verify plan and largest administrative closure records before any unit can start. */
export function preflightExperimentRecordBudget(plan: ExperimentPlan): void {
  const longestReason = 'not-run-after-interruption' as const
  const candidates: readonly [string, JsonValue][] = [
    ['plan-recorded', { plan: plan as unknown as JsonObject }],
    ['finalized', { reportKey: 'r'.repeat(128), unstarted: plan.units.map(unit => ({ unitKey: unit.unitKey, reason: longestReason })) }],
    ['unit-sealed', { unitKey: 'u'.repeat(128), outcome: 'result-unknown', reason: '\u0000'.repeat(4096), closure: 'confirmed', evidenceDigest: 'f'.repeat(64),
      evidence: { path: 'p'.repeat(4096), sha256: 'f'.repeat(64), byteLength: Number.MAX_SAFE_INTEGER }, measurement: { path: 'm'.repeat(4096), sha256: 'f'.repeat(64), byteLength: Number.MAX_SAFE_INTEGER } }],
  ]
  for (const [kind, payload] of candidates) {
    const sequence = sessionSequence(kind === 'plan-recorded' ? 1 : Number.MAX_SAFE_INTEGER)
    const bytes = encodeStoredSessionEvent({ envelopeVersion: 1, sessionId: plan.journalSessionId, eventId: formatSessionEventId(plan.journalSessionId, sequence), sequence,
      recordedAt: '9999-12-31T23:59:59.999Z', type: `experiment/${kind}`, payloadVersion: 1, payload }).byteLength
    if (bytes > plan.storage.maxRecordBytes) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'journal-record-budget', { kind, bytes, maxRecordBytes: plan.storage.maxRecordBytes })
  }
}

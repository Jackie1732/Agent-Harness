import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { ExperimentFileRef, ExperimentPlan } from './definition-types.js'
import type { SessionAddress, SessionEventId } from '../session/ids.js'

export type ExperimentOutcome = 'completed' | 'failed' | 'result-unknown' | 'cancelled' | 'timed-out' | 'interrupted'
export type ExperimentUnstartedReason = 'skipped-by-policy' | 'cancelled-before-start' | 'not-run-after-interruption'
export interface ExperimentPlanRecorded extends JsonObject { readonly plan: JsonObject }
export interface ExperimentUnitStarted extends JsonObject {
  readonly unitKey: string
  readonly templateDigest: string
  readonly recipeDigest: string
  readonly recipe: ExperimentFileRef
}
export interface ExperimentUnitSealed extends JsonObject {
  readonly unitKey: string
  readonly outcome: ExperimentOutcome
  readonly reason: string
  readonly closure: 'confirmed'
  readonly evidenceDigest: string
  readonly evidence: ExperimentFileRef
  readonly measurement: ExperimentFileRef | null
}
export interface ExperimentUnitUnresolved extends JsonObject {
  readonly unitKey: string
  readonly outcome: ExperimentOutcome
  readonly reason: string
  readonly closure: 'confirmed' | 'failed' | 'unknown'
  readonly evidence: ExperimentFileRef | null
}
export interface ExperimentEvidenceRecorded extends JsonObject {
  readonly unitKey: string
  readonly evidenceKey: string
  readonly evidenceDigest: string
  readonly evidence: ExperimentFileRef
  readonly derivedFrom: ExperimentDerivedFrom
}
/** Source declared by an explicit management review; original dispositions remain immutable. */
export interface ExperimentDerivedFrom extends JsonObject {
  readonly kind: 'reviewed-copy/v1'
  readonly actionKey: string
  readonly originalDisposition: { readonly address: SessionAddress; readonly eventId: SessionEventId }
  readonly originalEvidence: ExperimentFileRef | null
  readonly recipeDigest: string
  readonly sourceRoot: string
}
export interface ExperimentEvaluationSettled extends JsonObject {
  readonly unitKey: string
  readonly evidenceDigest: string
  readonly evaluatorDigest: string
  readonly evaluatorVersion: string
  readonly result: JsonObject
}
export interface ExperimentReportRecorded extends JsonObject {
  readonly reportKey: string
  readonly kind: 'primary' | 'posthoc'
  readonly report: ExperimentFileRef
  readonly cut: number
  readonly selections: readonly JsonObject[]
}
export interface ExperimentFinalized extends JsonObject {
  readonly reportKey: string
  readonly unstarted: readonly { readonly unitKey: string; readonly reason: ExperimentUnstartedReason }[]
}
export interface ExperimentEventPayloads {
  readonly 'plan-recorded': ExperimentPlanRecorded
  readonly 'unit-started': ExperimentUnitStarted
  readonly 'unit-sealed': ExperimentUnitSealed
  readonly 'unit-unresolved': ExperimentUnitUnresolved
  readonly 'evidence-recorded': ExperimentEvidenceRecorded
  readonly 'evaluation-settled': ExperimentEvaluationSettled
  readonly 'report-recorded': ExperimentReportRecorded
  readonly finalized: ExperimentFinalized
}
export type ExperimentEventKind = keyof ExperimentEventPayloads
export interface ExperimentUnitState {
  readonly unitKey: string
  readonly started: CommittedSessionEvent<ExperimentUnitStarted> | null
  readonly sealed: CommittedSessionEvent<ExperimentUnitSealed> | null
  readonly unresolved: CommittedSessionEvent<ExperimentUnitUnresolved> | null
  readonly notRun: ExperimentUnstartedReason | null
}
/** Projection contains committed event records rather than a second authoritative fact table. */
export interface ExperimentJournalSnapshot {
  readonly plan: ExperimentPlan | null
  readonly units: readonly ExperimentUnitState[]
  readonly evidence: readonly CommittedSessionEvent<ExperimentEvidenceRecorded>[]
  readonly evaluations: readonly CommittedSessionEvent<ExperimentEvaluationSettled>[]
  readonly reports: readonly CommittedSessionEvent<ExperimentReportRecorded>[]
  readonly finalized: CommittedSessionEvent<ExperimentFinalized> | null
  readonly activeUnit: string | null
  readonly position: number
}
export type ExperimentAnyEvent = CommittedSessionEvent<ExperimentEventPayloads[ExperimentEventKind] & JsonValue>

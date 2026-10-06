import type { JsonObject } from '../foundation/json.js'
import type { SessionAddress } from '../session/ids.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import type { ExperimentFileRef, ExperimentPlan } from './definition-types.js'
import type { ExperimentEvaluationStatus } from './evaluation-types.js'
import type { ExperimentJournalSnapshot, ExperimentOutcome, ExperimentUnstartedReason } from './journal-types.js'
import type { ExperimentCountMetricName, ExperimentMetrics, ModelUsageField } from './metrics-types.js'
import type { ExperimentMeasurement } from './runner-types.js'

export type ComparisonNumericMetricName = `count.${ExperimentCountMetricName}` | `token.${ModelUsageField}`
  | 'time.initMs' | 'time.driveMs' | 'time.shutdownMs' | 'time.totalMs'
export interface ComparisonObservation {
  readonly unitKey: string
  readonly evidenceDigest: string
  readonly metrics: ExperimentMetrics | null
  readonly measurement: { readonly reference: ExperimentFileRef; readonly value: ExperimentMeasurement } | null
}
/** A caller supplies a projection for the explicit Journal cut and original sealed evidence. */
export interface ExperimentResultSet {
  readonly plan: ExperimentPlan
  readonly journal: ExperimentJournalSnapshot
  readonly cut: number
  readonly observations: readonly ComparisonObservation[]
}
export interface ComparisonEvaluationSelection {
  readonly unitKey: string
  readonly evaluationEvent: WorkflowEventRef | null
}
export interface CompareExperimentResultsInput {
  readonly results: ExperimentResultSet
  readonly comparisonKey: string
  readonly numericMetrics: readonly ComparisonNumericMetricName[]
}
export interface CompareCrossExperimentResultsInput {
  readonly a: ExperimentResultSet
  readonly variantA: string
  readonly b: ExperimentResultSet
  readonly variantB: string
  readonly comparisonKey: string
  readonly numericMetrics: readonly ComparisonNumericMetricName[]
}
export interface ComparisonRowObservation {
  readonly experimentId: SessionAddress
  readonly unitKey: string
  readonly disposition: 'not-started' | 'running' | 'sealed' | 'unresolved'
  readonly business: ExperimentOutcome | 'not-started' | 'running'
  readonly reason: string | null
  readonly notRun: ExperimentUnstartedReason | null
  readonly sealedEvent: WorkflowEventRef | null
  readonly evidenceDigest: string | null
  readonly evaluation: { readonly status: ExperimentEvaluationStatus | 'not-evaluated'; readonly score: number | null; readonly event: WorkflowEventRef | null }
  readonly numeric: Readonly<Record<string, number | null>>
  readonly knownNumeric: Readonly<Record<string, number>>
  readonly numericReasons: Readonly<Record<string, string | null>>
}
export interface ExperimentComparisonRow {
  readonly caseKey: string
  readonly repetition: number
  readonly a: ComparisonRowObservation
  readonly b: ComparisonRowObservation
}
export interface NumericStatistics {
  readonly count: number
  /** Includes known partial counters; they do not become complete numeric samples. */
  readonly knownSubtotal: number
  /** Arithmetic mean of the complete samples counted above. */
  readonly mean: number | null
  readonly min: number | null
  readonly max: number | null
}
export interface CaseBalancedStatistics {
  readonly validCases: number
  readonly missingCases: number
  readonly mean: number | null
}
export interface ComparisonNumericSummary {
  readonly metric: ComparisonNumericMetricName
  readonly a: { readonly units: NumericStatistics; readonly caseBalanced: CaseBalancedStatistics }
  readonly b: { readonly units: NumericStatistics; readonly caseBalanced: CaseBalancedStatistics }
  readonly delta: { readonly definition: 'B-A'; readonly completePairs: NumericStatistics; readonly caseBalanced: CaseBalancedStatistics }
  readonly cases: readonly { readonly caseKey: string; readonly plannedRepetitions: number; readonly missingA: number; readonly missingB: number;
    readonly missingPairs: number; readonly a: NumericStatistics; readonly b: NumericStatistics; readonly delta: NumericStatistics }[]
}
export interface ComparisonArmSummary {
  readonly planned: number
  readonly started: number
  readonly sealed: number
  readonly unresolved: number
  readonly notStarted: number
  readonly completed: number
  readonly businessCounts: Readonly<Record<string, number>>
  readonly notRunCounts: Readonly<Record<ExperimentUnstartedReason, number>>
  readonly qualityCounts: Readonly<Record<ExperimentEvaluationStatus | 'not-evaluated', number>>
  readonly plannedPassRate: number
  readonly evaluatedPassRate: number | null
  readonly evaluationCoverage: number
  readonly completedRate: number
  readonly sealedCoverage: number
}
export interface ExperimentComparison {
  readonly version: 1
  readonly comparisonKey: string
  readonly status: 'primary-fixed' | 'provisional'
  readonly definitionVersion: 'paired-description/v1'
  readonly datasetDigest: string
  readonly mode: 'fixture' | 'live'
  readonly arms: readonly { readonly side: 'A' | 'B'; readonly experimentId: SessionAddress; readonly variantKey: string;
    readonly factors: JsonObject; readonly journalCut: number; readonly selectionCut: number; readonly selectionStatus: 'primary-fixed' | 'provisional' }[]
  readonly rows: readonly ExperimentComparisonRow[]
  readonly summary: { readonly a: ComparisonArmSummary; readonly b: ComparisonArmSummary;
    readonly qualityCross: { readonly bothPass: number; readonly aPassBFail: number; readonly aFailBPass: number; readonly bothFail: number; readonly missing: number } }
  readonly numeric: readonly ComparisonNumericSummary[]
}

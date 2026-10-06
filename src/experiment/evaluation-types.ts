import type { JsonObject } from '../foundation/json.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import type { ExperimentCase, ExperimentEvaluator } from './definition-types.js'
import type { ExperimentObservedOutput } from './evidence-types.js'

export type ExperimentEvaluationStatus = 'pass' | 'fail' | 'unavailable' | 'error'
export interface ExperimentRuleResult {
  readonly ruleKey: string
  readonly status: ExperimentEvaluationStatus
  readonly reason: string
  readonly details: JsonObject
  readonly evidenceRefs: readonly WorkflowEventRef[]
}
/** Identity and coverage are independent of the business outcome and schema acceptance. */
export interface ExperimentEvaluationResult {
  readonly version: 1
  readonly unitKey: string
  readonly outputKey: string
  readonly evidenceDigest: string
  readonly evaluatorKey: string
  readonly evaluatorDigest: string
  readonly evaluatorVersion: string
  readonly implementationVersion: 'rules/v1'
  readonly overall: ExperimentEvaluationStatus
  readonly rules: readonly ExperimentRuleResult[]
  readonly totalRules: number
  readonly knownPassed: number
  readonly evaluatedRules: number
  readonly coverage: number
  readonly score: number | null
}
export interface EvaluateExperimentOutputInput {
  readonly unitKey: string
  readonly case: Pick<ExperimentCase, 'output'>
  readonly evaluator: ExperimentEvaluator
  readonly evidenceDigest: string
  readonly output: ExperimentObservedOutput
  readonly maxJsonBytes: number
}

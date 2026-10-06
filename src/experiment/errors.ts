import { HarnessError } from '../foundation/error.js'
import type { JsonObject } from '../foundation/json.js'

export const experimentErrorCodes = ['EXPERIMENT_INPUT_INVALID', 'EXPERIMENT_LIMIT_EXCEEDED', 'EXPERIMENT_CONFLICT',
  'EXPERIMENT_STATE_INVALID', 'EXPERIMENT_INACTIVE', 'EXPERIMENT_COMMIT_UNKNOWN', 'EXPERIMENT_EVIDENCE_INCOMPLETE'] as const
export type ExperimentErrorCode = typeof experimentErrorCodes[number]

/** Finite experiment diagnostics preserve the owning failure without exposing input material. */
export class ExperimentError extends HarnessError<ExperimentErrorCode> {
  constructor(code: ExperimentErrorCode, reason: string, details: JsonObject = {}, options: ErrorOptions = {}) {
    super(code, reason, { details, ...options })
    this.name = 'ExperimentError'
  }
}

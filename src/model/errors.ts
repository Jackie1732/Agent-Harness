import { HarnessError } from '../foundation/error.js'
import type { JsonObject } from '../foundation/json.js'

/** Stable boundary failures; a settled business outcome is not an exception. */
export const modelErrorCodes = Object.freeze([
  'MODEL_REQUEST_INVALID',
  'MODEL_FEATURE_UNSUPPORTED',
  'MODEL_PROVIDER_INACTIVE',
  'MODEL_PROVIDER_BUSY',
  'MODEL_PROVIDER_FAILED',
  'MODEL_BINDING_MISMATCH',
  'MODEL_SESSION_BUSY',
  'MODEL_SESSION_CATALOG_INCOMPATIBLE',
  'MODEL_SESSION_CHANGED',
  'MODEL_RUNNER_INACTIVE',
  'MODEL_CALL_CANCELLED',
  'MODEL_STATE_INVALID',
  'MODEL_PROTOCOL_INVALID',
  'MODEL_HTTP_FAILED',
  'MODEL_LIMIT_EXCEEDED',
  'MODEL_JOURNAL_COMMIT_UNKNOWN',
  'MODEL_JOURNAL_WRITE_FAILED',
  'MODEL_CLEANUP_FAILED',
  'MODEL_REENTRANT_WAIT',
] as const)

export type ModelErrorCode = typeof modelErrorCodes[number]

/** No raw HTTP body, authentication, or provider exception is attached as a cause. */
export class ModelError extends HarnessError<ModelErrorCode> {
  constructor(code: ModelErrorCode, message: string, details?: JsonObject) {
    super(code, message, details === undefined ? {} : { details })
    this.name = 'ModelError'
  }
}

/** Distinguish boundary errors from arbitrary provider exceptions without reading text. */
export function providerFailureCode(reason: unknown): ModelErrorCode {
  return reason instanceof ModelError ? reason.code : 'MODEL_PROVIDER_FAILED'
}

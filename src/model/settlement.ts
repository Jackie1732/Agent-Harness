import type { JsonObject } from '../foundation/json.js'
import type { ModelErrorCode } from './errors.js'
import type { ModelInvocationId } from './ids.js'
import type { NormalizedModelResult } from './contract.js'

export type ModelOutcome = 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'interrupted'
export type ModelExternalEvidence = 'not-issued' | 'may-have-been-issued' | 'response-observed'
export type ModelInvocationPhase = 'preparing' | 'recording' | 'acquiring' | 'starting' | 'streaming' | 'closing' | 'committing' | 'settled'

/** Fixed diagnostic vocabulary; no free-form remote body or exception is persisted. */
export interface ModelFailure extends JsonObject {
  readonly code: ModelErrorCode
  readonly phase: ModelInvocationPhase
  readonly retryable: boolean
  readonly httpStatus?: number
}

export interface ModelCleanup extends JsonObject {
  readonly status: 'complete' | 'incomplete' | 'unknown-after-process-loss'
  /** Null after process loss: zero would falsely assert that cleanup was observed. */
  readonly failedResources: number | null
}

/** CP2 is independent of generation, external observation, and resource recovery. */
export interface ModelSettlement extends JsonObject {
  readonly invocationId: ModelInvocationId
  readonly outcome: ModelOutcome
  readonly external: ModelExternalEvidence
  readonly result: NormalizedModelResult
  readonly cleanup: ModelCleanup
  readonly failure?: ModelFailure
}

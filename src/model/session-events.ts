import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { parseSessionEventId } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import type { ModelRunnerLimits, PreparedSubmission } from './contract.js'
import { decodeRunnerLimits } from './budget.js'
import { ModelError, modelErrorCodes } from './errors.js'
import { parseModelInvocationId } from './ids.js'
import type { ModelInvocationId } from './ids.js'
import { decodeNormalizedResult } from './result-codec.js'
import type { ModelSettlement } from './settlement.js'
import { decodePreparedSubmission } from './submission.js'
import { bool, integer, keys, object, oneOf, text } from './validation.js'

export interface ModelPreparedPayload extends JsonObject {
  readonly invocationId: ModelInvocationId
  readonly retryOf?: ModelInvocationId
  readonly submission: PreparedSubmission
  readonly limits: ModelRunnerLimits
}

export interface ModelStartedPayload extends JsonObject {
  readonly invocationId: ModelInvocationId
  readonly preparedEventId: SessionEventId
  readonly fingerprint: string
}

function decodePrepared(value: JsonValue): ModelPreparedPayload {
  const input = object(value, 'prepared event')
  keys(input, ['invocationId', 'submission', 'limits'], ['retryOf'])
  const invocationId = parseModelInvocationId(text(input.invocationId, 'invocation identity', 36, false))
  const retryOf = input.retryOf === undefined ? undefined : parseModelInvocationId(text(input.retryOf, 'retry identity', 36, false))
  const submission = decodePreparedSubmission(object(input.submission, 'submission'))
  const limits = decodeRunnerLimits(object(input.limits, 'runner limits'))
  return snapshotJson({ invocationId, submission, limits, ...(retryOf === undefined ? {} : { retryOf }) }) as ModelPreparedPayload
}

function decodeStarted(value: JsonValue): ModelStartedPayload {
  const input = object(value, 'started event')
  keys(input, ['invocationId', 'preparedEventId', 'fingerprint'])
  parseModelInvocationId(text(input.invocationId, 'invocation identity', 36, false))
  parseSessionEventId(text(input.preparedEventId, 'prepared event identity', 64, false))
  if (!/^[0-9a-f]{64}$/.test(text(input.fingerprint, 'fingerprint', 64, false))) {
    throw new ModelError('MODEL_STATE_INVALID', 'started fingerprint is not canonical')
  }
  return snapshotJson(input) as ModelStartedPayload
}

function decodeSettled(value: JsonValue): ModelSettlement {
  const input = object(value, 'settled event')
  keys(input, ['invocationId', 'outcome', 'external', 'result', 'cleanup'], ['failure'])
  parseModelInvocationId(text(input.invocationId, 'invocation identity', 36, false))
  const outcome = oneOf(input.outcome, ['completed', 'incomplete', 'failed', 'cancelled', 'interrupted'], 'invocation outcome')
  const external = oneOf(input.external, ['not-issued', 'may-have-been-issued', 'response-observed'], 'external observation')
  const result = decodeNormalizedResult(object(input.result, 'model result'))
  const cleanup = object(input.cleanup, 'cleanup result')
  keys(cleanup, ['status', 'failedResources'])
  const cleanupStatus = oneOf(cleanup.status, ['complete', 'incomplete', 'unknown-after-process-loss'], 'cleanup status')
  if (cleanupStatus === 'complete' && cleanup.failedResources !== 0
    || cleanupStatus === 'incomplete' && integer(cleanup.failedResources, 'failed resource count', 1) < 1
    || cleanupStatus === 'unknown-after-process-loss' && cleanup.failedResources !== null) {
    throw new ModelError('MODEL_STATE_INVALID', 'cleanup count contradicts its observation status')
  }
  if (cleanupStatus === 'unknown-after-process-loss' && outcome !== 'interrupted') throw new ModelError('MODEL_STATE_INVALID', 'unknown process cleanup requires interrupted outcome')
  if (outcome === 'completed' && (!result.protocolComplete || result.stopReason === 'length' || cleanupStatus !== 'complete')) throw new ModelError('MODEL_STATE_INVALID', 'completed outcome lacks complete generation')
  if (outcome === 'interrupted' && result.protocolComplete) throw new ModelError('MODEL_STATE_INVALID', 'recovery cannot invent complete generation')
  if (external !== 'response-observed' && result.responseId !== undefined
    || external === 'response-observed' && result.responseId === undefined) throw new ModelError('MODEL_STATE_INVALID', 'external observation contradicts response evidence')
  if (input.failure !== undefined) {
    const failure = object(input.failure, 'model failure')
    keys(failure, ['code', 'phase', 'retryable'], ['httpStatus'])
    oneOf(failure.code, modelErrorCodes, 'failure code')
    oneOf(failure.phase, ['preparing', 'recording', 'acquiring', 'starting', 'streaming', 'closing', 'committing', 'settled'], 'failure phase')
    bool(failure.retryable, 'retry suggestion')
    if (failure.httpStatus !== undefined) {
      const status = integer(failure.httpStatus, 'HTTP status', 100)
      if (status > 599) throw new ModelError('MODEL_STATE_INVALID', 'HTTP status is out of range')
    }
  }
  return snapshotJson(input) as ModelSettlement
}

export const modelPreparedEvent = createDurableEventDefinition({ type: 'model/invocation-prepared', payloadVersion: 1, ignorable: false, decode: decodePrepared })
export const modelStartedEvent = createDurableEventDefinition({ type: 'model/invocation-started', payloadVersion: 1, ignorable: false, decode: decodeStarted })
export const modelSettledEvent = createDurableEventDefinition({ type: 'model/invocation-settled', payloadVersion: 1, ignorable: false, decode: decodeSettled })

/** Compose these exact required definitions into the immutable Session Catalog. */
export const modelSessionEventDefinitions = Object.freeze([modelPreparedEvent, modelStartedEvent, modelSettledEvent])

import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { ModelRunnerLimits, NormalizedModelResult } from './contract.js'
import { ModelError } from './errors.js'
import { integer, keys, object } from './validation.js'

export const emptyModelResult = (): NormalizedModelResult => ({
  blocks: [], usage: { source: 'provider', completeness: 'unknown' },
  protocolComplete: false, stopReason: null,
})

export function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function decodeRunnerLimits(value: JsonValue): ModelRunnerLimits {
  const limits = object(value, 'model runner limits')
  keys(limits, ['maxInputBytes', 'maxNormalizedResultBytes', 'maxOutputBlocks', 'maxToolCalls', 'maxJournalConflicts'])
  for (const field of ['maxInputBytes', 'maxNormalizedResultBytes', 'maxOutputBlocks'] as const) integer(limits[field], field, 1)
  integer(limits.maxToolCalls, 'maxToolCalls')
  integer(limits.maxJournalConflicts, 'maxJournalConflicts')
  if (Number(limits.maxNormalizedResultBytes) < jsonBytes(emptyModelResult())) {
    throw new ModelError('MODEL_REQUEST_INVALID', 'normalized-result budget cannot hold the empty result')
  }
  return limits as ModelRunnerLimits
}

/** Maximum encoded envelope overhead for the existing Session v1 scalar bounds. */
export function modelEnvelopeBytes(type: string, payload: JsonValue): number {
  return jsonBytes({
    envelopeVersion: 1,
    sessionId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    eventId: 'ah-event:ffffffff-ffff-ffff-ffff-ffffffffffff:9007199254740991',
    sequence: Number.MAX_SAFE_INTEGER,
    recordedAt: '+275760-09-13T00:00:00.000Z',
    type, payloadVersion: 1, payload,
  })
}

/**
 * Prove space for every bounded CP2 shell before admitting paid work.
 * IDs are fixed UUIDs; failures contain only enums, boolean and bounded integers.
 * Model result, including usage and remote IDs, has its own inclusive byte ceiling.
 */
export function validateSettlementBudget(limitsInput: ModelRunnerLimits, maxRecordBytes: number): ModelRunnerLimits {
  const limits = decodeRunnerLimits(snapshotJson(limitsInput))
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw new ModelError('MODEL_REQUEST_INVALID', 'Session must report its enforced record budget')
  }
  const shell: JsonObject = {
    invocationId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    outcome: 'interrupted', external: 'may-have-been-issued',
    result: emptyModelResult(),
    cleanup: { status: 'unknown-after-process-loss', failedResources: Number.MAX_SAFE_INTEGER },
    // The strings reserve more than any v1 enum, not an arbitrary error-details bag.
    failure: { code: 'X'.repeat(64), phase: 'X'.repeat(16), retryable: false, httpStatus: 599 },
  }
  const overhead = modelEnvelopeBytes('model/invocation-settled', shell) - jsonBytes(emptyModelResult())
  if (limits.maxNormalizedResultBytes > maxRecordBytes - overhead) {
    throw new ModelError('MODEL_REQUEST_INVALID', 'normalized-result budget leaves insufficient durable settlement space', {
      maxRecordBytes, requiredOverheadBytes: overhead,
    })
  }
  return limits
}

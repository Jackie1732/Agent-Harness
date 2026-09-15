import type { JsonValue } from '../foundation/json.js'
import { inspectBoundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import { formatSessionEventId, sessionSequence } from '../session/ids.js'
import type { SessionHeader, StoredSessionEvent } from '../session/types.js'
import type { ModelRequest } from '../model/contract.js'
import type { ContextAssembly, ContextBuildFailure, ContextProfile, ContextUnitReference } from './contract.js'
import { invalidContext } from './errors.js'
import { jsonBytes } from './validation.js'

export type RequestMeasure = { readonly bytes: number; readonly estimatedTokens: number; readonly availableTokens: number }
const requestInspectionMaxBytes = 32 * 1024 * 1024
/** Exact neutral JSON bytes; estimates always cover the complete request including all wrappers. */
export function measureContextRequest(request: ModelRequest, profile: ContextProfile): RequestMeasure | Extract<ContextBuildFailure, { kind: 'resource-limit' }> {
  try {
    const measured = inspectBoundedJson(request, { maxBytes: requestInspectionMaxBytes,
      maxDepth: profile.budget.maxJsonDepth, maxNodes: profile.budget.maxJsonNodes })
    const accounting = profile.tokenAccounting
    const estimatedTokens = Math.ceil(measured.bytes / accounting.bytesPerEstimatedToken) + accounting.fixedOverheadEstimate
    const availableTokens = profile.budget.contextWindowTokens - profile.budget.outputReserveTokens - profile.budget.safetyMarginTokens
    if (!Number.isSafeInteger(estimatedTokens) || !Number.isSafeInteger(availableTokens)) invalidContext('token-arithmetic')
    return Object.freeze({ bytes: measured.bytes, estimatedTokens, availableTokens })
  } catch (reason) {
    if (reason instanceof JsonBoundaryError && reason.reason !== 'invalid') {
      const maximum = reason.reason === 'bytes' ? requestInspectionMaxBytes
        : reason.reason === 'depth' ? profile.budget.maxJsonDepth : profile.budget.maxJsonNodes
      return { kind: 'resource-limit', limit: 'json', maximum }
    }
    throw reason
  }
}
export function requestBudgetFailure(measure: RequestMeasure, profile: ContextProfile, references: readonly ContextUnitReference[]): Extract<ContextBuildFailure, { kind: 'budget-exceeded' }> | undefined {
  if (measure.bytes > profile.budget.maxRequestBytes) return { kind: 'budget-exceeded', limit: 'request-bytes', required: measure.bytes, available: profile.budget.maxRequestBytes, references }
  if (measure.estimatedTokens > measure.availableTokens) return { kind: 'budget-exceeded', limit: 'input-tokens', required: measure.estimatedTokens, available: measure.availableTokens, references }
  return undefined
}
/** Session owns future recordedAt. A maximal valid ISO width is a conservative preflight, not an exact timestamp claim. */
export function contextEnvelopeUpperBound(header: SessionHeader, position: number, type: string, payload: JsonValue): number {
  const sequence = sessionSequence(position + 1)
  const event: StoredSessionEvent = { envelopeVersion: 1, sessionId: header.sessionId,
    eventId: formatSessionEventId(header.sessionId, sequence), sequence, recordedAt: '+275760-09-13T00:00:00.000Z',
    type, payloadVersion: 1, payload }
  return jsonBytes(event as unknown as JsonValue)
}
/** Resolve the self-size field without an unbounded fixed-point loop. Only its decimal width can change. */
export function measureAssemblyEnvelope(header: SessionHeader, position: number, assembly: ContextAssembly): ContextAssembly {
  let candidate = assembly
  for (let pass = 0; pass < 8; pass++) {
    const size = contextEnvelopeUpperBound(header, position, 'context/assembly-committed', candidate)
    if (size === candidate.budget.assemblyEnvelopeUpperBoundBytes) return candidate
    candidate = { ...candidate, budget: { ...candidate.budget, assemblyEnvelopeUpperBoundBytes: size } }
  }
  return invalidContext('envelope-size-fixed-point')
}

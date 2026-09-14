import type { SessionHandle } from '../session/session-handle.js'
import type { JsonValue } from '../foundation/json.js'
import type { ToolInvocationLimits } from './contract.js'
import { ToolError } from './errors.js'
import type { ToolInvocationId } from './ids.js'
import { jsonBytes } from './validation.js'

/** Worst legal Session scalar lengths, not a guessed fixed envelope allowance. */
function envelopeOverhead(handle: SessionHandle, type: string): number {
  return jsonBytes({ envelopeVersion: 1, sessionId: handle.header.sessionId,
    eventId: `ah-event:${handle.header.sessionId}:${Number.MAX_SAFE_INTEGER}`,
    sequence: Number.MAX_SAFE_INTEGER, recordedAt: '+275760-09-13T00:00:00.000Z',
    type, payloadVersion: 1, payload: null,
  }) - 4
}
export function assertRecordCapacity(handle: SessionHandle, type: string, payload: JsonValue): void {
  if (!Number.isSafeInteger(handle.maxRecordBytes) || handle.maxRecordBytes < 1
    || envelopeOverhead(handle, type) + jsonBytes(payload) > handle.maxRecordBytes) {
    throw new ToolError('TOOL_RECORD_BUDGET', 'tool fact cannot fit the actual Session record ceiling')
  }
}

/** Reserve maximum canonical result plus every optional diagnostic/receipt/cleanup field. */
export function assertSettlementCapacity(handle: SessionHandle, invocationId: ToolInvocationId, limits: ToolInvocationLimits): void {
  const shell = { invocationId, outcome: 'interrupted', execution: 'execution-observed', emission: 'may-have-occurred',
    result: null, cleanup: { status: 'unknown-after-process-loss', attempted: Number.MAX_SAFE_INTEGER, failed: Number.MAX_SAFE_INTEGER },
    failure: { code: 'X'.repeat(64), phase: 'authorizing' }, receipt: 'X'.repeat(128),
  }
  if (envelopeOverhead(handle, 'tool/invocation-settled') + jsonBytes(shell) - 4 + limits.maxResultBytes > handle.maxRecordBytes) {
    throw new ToolError('TOOL_RECORD_BUDGET', 'maximum tool settlement cannot fit the actual Session record ceiling')
  }
}

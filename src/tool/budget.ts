import type { SessionHandle } from '../session/session-handle.js'
import type { JsonValue } from '../foundation/json.js'
import type { ToolDefinition, ToolInvocationLimits } from './contract.js'
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

/** Reserve a terminal failure record before the provider-specific result ceiling is known. */
export function assertMinimalSettlementCapacity(handle: SessionHandle, invocationId: ToolInvocationId): void {
  const failed = {
    invocationId,
    outcome: 'failed',
    execution: 'not-started',
    emission: 'none',
    result: { kind: 'error', code: 'X'.repeat(64) },
    cleanup: { status: 'complete', attempted: 0, failed: 0 },
    failure: { code: 'X'.repeat(64), phase: 'preparing' },
  } as const
  const interrupted = {
    invocationId,
    outcome: 'interrupted',
    execution: 'not-started',
    emission: 'none',
    result: { kind: 'none' },
    cleanup: { status: 'unknown-after-process-loss', attempted: null, failed: null },
  } as const
  assertRecordCapacity(handle, 'tool/invocation-settled', failed)
  assertRecordCapacity(handle, 'tool/invocation-settled', interrupted)
}

/** Reserve the largest legal runtime settlement after provider-specific limits are known. */
export function assertSettlementCapacity(
  handle: SessionHandle,
  invocationId: ToolInvocationId,
  limits: ToolInvocationLimits,
  operationClass: ToolDefinition['operationClass'],
): void {
  const external = operationClass === 'external'
  const evidence = external ? { emission: 'observed' as const, receipt: 'X'.repeat(128) }
    : { emission: 'none' as const }
  const resultShell = {
    invocationId,
    outcome: 'succeeded',
    execution: 'execution-observed',
    ...evidence,
    result: null,
    cleanup: { status: 'incomplete', attempted: 1, failed: 1 },
  } as const
  const failed = {
    invocationId,
    outcome: 'failed',
    execution: 'execution-observed',
    emission: external ? 'may-have-occurred' as const : 'none' as const,
    result: { kind: 'error', code: 'X'.repeat(64) },
    cleanup: { status: 'incomplete', attempted: 1, failed: 1 },
    failure: { code: 'X'.repeat(64), phase: 'executing' },
  } as const
  const interrupted = {
    invocationId,
    outcome: 'interrupted',
    execution: 'may-have-executed',
    emission: external ? 'may-have-occurred' as const : 'none' as const,
    result: { kind: 'none' },
    cleanup: { status: 'unknown-after-process-loss', attempted: null, failed: null },
  } as const
  const available = handle.maxRecordBytes - envelopeOverhead(handle, 'tool/invocation-settled')
  const resultOverhead = jsonBytes(resultShell) - 4
  if (available < 0 || resultOverhead > available || limits.maxResultBytes > available - resultOverhead
    || jsonBytes(failed) > available || jsonBytes(interrupted) > available) {
    throw new ToolError('TOOL_RECORD_BUDGET', 'maximum tool settlement cannot fit the actual Session record ceiling')
  }
}

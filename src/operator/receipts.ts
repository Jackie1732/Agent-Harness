import { createHash } from 'node:crypto'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { ControlMethod } from '../protocol/index.js'
import type { Result } from '../protocol/index.js'
import { parseSessionEventId, parseSessionAddress } from '../session/ids.js'
import type { OperatorIntent, OperatorAcceptance } from './types.js'

export function operatorDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Extract only the receipt's explicit owning Session; cuts are independent observations. */
export function receiptOwnerSession(method: ControlMethod, result: unknown): string | null {
  switch (method) {
    case 'input.submit': case 'input.answer': case 'root.cancel': case 'message.send': case 'message.reply':
      return (result as Result<'input.submit'>).sessionId
    case 'delegation.spawn': return parseSessionEventId((result as Result<'delegation.spawn'>).delegationId).sessionId
    case 'delegation.cancel': {
      const receipt = result as Result<'delegation.cancel'>
      return receipt.status === 'requested' ? parseSessionEventId(receipt.eventId).sessionId : null
    }
    case 'workflow.pause': case 'workflow.resume': case 'workflow.cancel': case 'workflow.retry':
      return parseSessionAddress((result as Result<'workflow.pause'>).ref.address)
    default: return null
  }
}

/** Receipt summaries contain scalar references, counts and hashes rather than growing reports. */
export function summarizeOperatorReceipt(method: ControlMethod, result: unknown): JsonObject {
  const value = result as Record<string, JsonValue>
  const summary: Record<string, JsonValue> = {}
  for (const key of ['instanceId', 'sessionId', 'agentKey', 'workflowKey', 'nodeKey', 'inputEventId', 'reused',
    'status', 'hostStatus', 'mode', 'paused', 'rootId', 'stopControl', 'outcome', 'runId', 'commandEventId', 'outboxAcceptedEventId',
    'messageId', 'delegationId', 'childSessionId', 'childAddress', 'eventId', 'ref', 'artifactRef', 'decisionRef', 'assignmentRef', 'proposalRef']) {
    const field = value[key]
    if (field !== undefined) summary[key] = field
  }
  if (value.cuts !== undefined) {
    summary.cutsCount = (value.cuts as readonly JsonValue[]).length
    summary.cutsDigest = operatorDigest(value.cuts)
  }
  if (value.resumptions !== undefined) {
    summary.resumptionsCount = (value.resumptions as readonly JsonValue[]).length
    summary.resumptionsDigest = operatorDigest(value.resumptions)
  }
  if (method === 'host.run') {
    const report = value.report as Record<string, JsonValue>
    for (const key of ['stoppedBy', 'batches', 'businessRuns', 'maintenanceRuns', 'deliveryAttempts', 'counts', 'truncated']) summary[key] = report[key]!
  }
  return summary
}

export function operatorOutcome(acceptance: OperatorAcceptance, result: unknown, errorCode: string | null,
  method: ControlMethod): NonNullable<OperatorIntent['outcome']> {
  return { acceptance, resultDigest: result === null ? null : operatorDigest(result),
    summary: result === null ? {} : summarizeOperatorReceipt(method, result), receivedAt: new Date().toISOString(), errorCode }
}

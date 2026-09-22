import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import type { DelegationRequested } from './event-contract.js'
import { SubagentError } from './errors.js'

const eventId = 'ah-event:00000000-0000-4000-8000-000000000000:9007199254740991'
const messageId = '00000000-0000-4000-8000-000000000000'
const timestamp = '+275760-09-13T00:00:00.000Z'
const size = (value: JsonValue) => canonicalJsonBytes(value).byteLength
function recordBytes(type: string, payload: JsonValue, version = 1): number {
  return size({ envelopeVersion: 1, sessionId: messageId, eventId, sequence: Number.MAX_SAFE_INTEGER, recordedAt: timestamp, type, payloadVersion: version, payload })
}

/** Reserve both copies in keyed Outbox records, as well as the receiving envelope and CP-D installation facts. */
export function assertDelegationRecordCapacity(request: DelegationRequested, maximum: number, messageMaximum: number): void {
  if (resultMetadataBytes([], '') > request.effectivePlan.template.limits.maxResultBytes) throw new SubagentError('SUBAGENT_REQUEST_INVALID', 'delegation-result-metadata-limit')
  const identity = { delegation: eventId, parentAddress: request.parentAddress, childAddress: request.childAddress }
  const envelope = { envelopeVersion: 1, messageId, sender: request.parentAddress, recipient: request.childAddress, channelId: request.channelId,
    channelSequence: Number.MAX_SAFE_INTEGER, correlationId: messageId, causationId: messageId, replyTo: messageId, createdAt: timestamp,
    type: 'subagent/question', payloadVersion: 1, payload: null }
  // Include both union variants when bounding overhead; no such synthetic command is persisted.
  const command = { kind: 'send', inboxMessageId: messageId, request: { kind: 'derived', recipient: request.childAddress,
    channelId: request.channelId, correlationId: messageId, causationId: messageId }, type: 'subagent/question', payloadVersion: 1, payload: null }
  const task = { delegation: eventId, parentRoot: request.parentRoot, childSessionId: request.childSessionId, task: request.request.task,
    materials: request.request.materials, grant: request.grant, workspace: request.effectivePlan.workspace, deadline: request.deadline }
  const payloadBytes = Math.max(size(task), request.effectivePlan.template.limits.maxResultBytes)
  const protocol = { ...identity, kind: 'question', ordinal: Number.MAX_SAFE_INTEGER, command,
    source: { kind: 'action', action: { eventId, index: Number.MAX_SAFE_INTEGER }, intent: { invocationId: messageId, outputBlockIndex: Number.MAX_SAFE_INTEGER, callId: '\u0000'.repeat(256) } }, observedAt: timestamp }
  if (recordBytes('subagent/delegation-requested', request) > maximum || recordBytes('subagent/child-bound', { ...identity, requested: request }) > maximum
    || size(envelope) - 4 + payloadBytes > messageMaximum || size(command) - 4 + payloadBytes > messageMaximum
    || recordBytes('communication/outbox-accepted', { envelope, command, sendKey: { eventId, index: 0 } }, 2) - 8 + 2 * payloadBytes > maximum
    || recordBytes('subagent/protocol-recorded', protocol) - 4 + payloadBytes > maximum) throw new SubagentError('SUBAGENT_REQUEST_INVALID', 'delegation-record-limit')
}

/** Upper bound for one potential file per accepted write; summary is the only truncatable result field. */
export function resultMetadataBytes(paths: readonly string[], resourceId: string): number {
  return size({ delegation: eventId, parentRoot: eventId, childSessionId: messageId, childRoot: eventId, outcome: 'budget-exhausted',
    summary: { text: '', sourceBytes: Number.MAX_SAFE_INTEGER, truncated: true }, files: [],
    uncertainFiles: paths.map(path => ({ resourceId, path, source: eventId, byteLength: Number.MAX_SAFE_INTEGER, sha256: '0'.repeat(64), reasonCode: 'X'.repeat(128) })),
    executionRelease: { eventId, outcome: 'cleanup-incomplete' }, source: { turn: eventId, settled: eventId, terminal: eventId } })
}

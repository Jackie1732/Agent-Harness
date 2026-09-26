import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject } from '../foundation/json.js'
import type { MessageSendCommand } from '../communication/send-command.js'
import type { MessageEnvelope } from '../communication/types.js'
import { formatSessionAddress, formatSessionEventId, sessionSequence } from '../session/ids.js'
import type { SessionId } from '../session/ids.js'
import { WorkflowError } from './errors.js'

export interface WorkflowMessageBudget { readonly maxMessageBytes: number; readonly maxRecordBytes: number }

/** Check escaped complete command, Envelope and keyed journal records before reserving or publishing business data. */
export function assertWorkflowMessageFits(sessionId: SessionId, command: MessageSendCommand, limits: WorkflowMessageBudget, reply?: MessageEnvelope): void {
  if (command.kind === 'reply' && reply === undefined) throw new WorkflowError('WORKFLOW_HISTORY_INVALID', 'workflow-reply-source-required')
  const id = '00000000-0000-4000-8000-000000000000'
  const eventId = formatSessionEventId(sessionId, sessionSequence(Number.MAX_SAFE_INTEGER))
  const envelope = { envelopeVersion: 1, messageId: id, sender: formatSessionAddress(sessionId),
    recipient: command.kind === 'reply' ? reply!.sender : command.request.recipient,
    channelId: command.kind === 'reply' ? reply!.channelId : command.request.channelId,
    ...(command.kind === 'reply' ? { causationId: reply!.messageId, replyTo: reply!.messageId }
      : command.request.kind === 'derived' ? { causationId: command.request.causationId } : {}), channelSequence: Number.MAX_SAFE_INTEGER, correlationId: id,
    createdAt: '2000-01-01T00:00:00.000Z', type: command.type, payloadVersion: command.payloadVersion, payload: command.payload }
  const bytes = (value: unknown) => canonicalJsonBytes(value as JsonObject).byteLength
  if (bytes(command) > limits.maxMessageBytes || bytes(envelope) > limits.maxMessageBytes) {
    throw new WorkflowError('WORKFLOW_RESULT_INVALID', 'workflow-message-bytes')
  }
  const record = { envelopeVersion: 1, sessionId, eventId, sequence: Number.MAX_SAFE_INTEGER,
    recordedAt: envelope.createdAt, type: 'communication/outbox-accepted', payloadVersion: 2,
    payload: { envelope, sendKey: { eventId, index: Number.MAX_SAFE_INTEGER }, command } }
  if (bytes(record) > limits.maxRecordBytes) throw new WorkflowError('WORKFLOW_RESULT_INVALID', 'workflow-message-record-bytes')
}

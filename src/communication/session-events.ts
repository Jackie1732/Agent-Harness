import type { JsonObject, JsonValue } from '../foundation/json.js'
import { keyedOutboxAcceptedEvent } from './keyed-event.js'
import { createDurableEventDefinition, parseSessionEventId } from '../session/index.js'
import type { DurableEventDefinition, SessionEventId } from '../session/index.js'
import { requireExactKeys, requireNumber, requireRecord, requireString } from './codec-fields.js'
import { decodeMessageEnvelope } from './envelope.js'
import { parseMessageId } from './ids.js'
import type { MessageId } from './ids.js'
import type {
  InboxAbandonReason,
  MessageEnvelope,
  MessageRejectionCode,
  MessageRetryCode,
  OutboxAbandonReason,
} from './types.js'

/** Durable payload accepting one immutable Envelope into a sender Outbox. */
export interface OutboxAcceptedPayload extends JsonObject {
  readonly envelope: MessageEnvelope
}

/** Durable payload recording the start of one external delivery attempt. */
export interface OutboxAttemptStartedPayload extends JsonObject {
  readonly messageId: MessageId
  readonly attempt: number
}

/** Durable payload recording a retryable delivery result. */
export interface OutboxAttemptFailedPayload extends JsonObject {
  readonly messageId: MessageId
  readonly attempt: number
  readonly code: MessageRetryCode
}

/** Durable payload proving one receiver Inbox accepted the Message. */
export interface OutboxDeliveredPayload extends JsonObject {
  readonly messageId: MessageId
  readonly attempt: number
  readonly inboxEventId: SessionEventId
}

/** Durable payload recording one explicit terminal delivery rejection. */
export interface OutboxRejectedPayload extends JsonObject {
  readonly messageId: MessageId
  readonly attempt: number
  readonly code: MessageRejectionCode
}

/** Durable payload stopping local delivery attempts without remote claims. */
export interface OutboxAbandonedPayload extends JsonObject {
  readonly messageId: MessageId
  readonly reason: OutboxAbandonReason
}

/** Durable payload accepting one immutable Envelope into a recipient Inbox. */
export interface InboxAcceptedPayload extends JsonObject {
  readonly envelope: MessageEnvelope
  readonly digest: string
}

/** Durable payload marking one Inbox Message processed. */
export interface InboxProcessedPayload extends JsonObject {
  readonly messageId: MessageId
}

/** Durable payload declining further processing of one Inbox Message. */
export interface InboxAbandonedPayload extends JsonObject {
  readonly messageId: MessageId
  readonly reason: InboxAbandonReason
}

const retryCodes = new Set<MessageRetryCode>([
  'recipient-offline',
  'recipient-ending',
  'recipient-backpressure',
  'attempt-interrupted',
  'receiver-outcome-unknown',
  'transport-outcome-unknown',
])
const rejectionCodes = new Set<MessageRejectionCode>([
  'recipient-unknown',
  'recipient-ended',
  'receive-forbidden',
  'message-unsupported',
  'payload-invalid',
  'message-id-conflict',
])
const outboxAbandonReasons = new Set<OutboxAbandonReason>(['caller-requested', 'attempts-exhausted'])
const inboxAbandonReasons = new Set<InboxAbandonReason>(['caller-requested', 'unsupported-message'])
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

function messageReference(value: JsonObject): MessageId {
  return parseMessageId(requireString(value.messageId, 'communication event messageId'))
}

function attemptNumber(value: JsonObject): number {
  const attempt = requireNumber(value.attempt, 'communication event attempt')
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError('communication event attempt must be a positive safe integer')
  }
  return attempt
}

function eventId(value: JsonValue | undefined): SessionEventId {
  const text = requireString(value, 'communication event inboxEventId')
  parseSessionEventId(text)
  return text as SessionEventId
}

function decodeAccepted(value: JsonValue): OutboxAcceptedPayload {
  const record = requireRecord(value, 'outbox accepted payload')
  requireExactKeys(record, ['envelope'], [], 'outbox accepted payload')
  return Object.freeze({ envelope: decodeMessageEnvelope(record.envelope as JsonValue) })
}

function decodeAttemptStarted(value: JsonValue): OutboxAttemptStartedPayload {
  const record = requireRecord(value, 'outbox attempt-started payload')
  requireExactKeys(record, ['messageId', 'attempt'], [], 'outbox attempt-started payload')
  return Object.freeze({ messageId: messageReference(record), attempt: attemptNumber(record) })
}

function decodeAttemptFailed(value: JsonValue): OutboxAttemptFailedPayload {
  const record = requireRecord(value, 'outbox attempt-failed payload')
  requireExactKeys(record, ['messageId', 'attempt', 'code'], [], 'outbox attempt-failed payload')
  const code = requireString(record.code, 'outbox attempt-failed code') as MessageRetryCode
  if (!retryCodes.has(code)) throw new TypeError('outbox attempt-failed code is unsupported')
  return Object.freeze({ messageId: messageReference(record), attempt: attemptNumber(record), code })
}

function decodeDelivered(value: JsonValue): OutboxDeliveredPayload {
  const record = requireRecord(value, 'outbox delivered payload')
  requireExactKeys(record, ['messageId', 'attempt', 'inboxEventId'], [], 'outbox delivered payload')
  return Object.freeze({
    messageId: messageReference(record),
    attempt: attemptNumber(record),
    inboxEventId: eventId(record.inboxEventId),
  })
}

function decodeRejected(value: JsonValue): OutboxRejectedPayload {
  const record = requireRecord(value, 'outbox rejected payload')
  requireExactKeys(record, ['messageId', 'attempt', 'code'], [], 'outbox rejected payload')
  const code = requireString(record.code, 'outbox rejected code') as MessageRejectionCode
  if (!rejectionCodes.has(code)) throw new TypeError('outbox rejected code is unsupported')
  return Object.freeze({ messageId: messageReference(record), attempt: attemptNumber(record), code })
}

function decodeOutboxAbandoned(value: JsonValue): OutboxAbandonedPayload {
  const record = requireRecord(value, 'outbox abandoned payload')
  requireExactKeys(record, ['messageId', 'reason'], [], 'outbox abandoned payload')
  const reason = requireString(record.reason, 'outbox abandoned reason') as OutboxAbandonReason
  if (!outboxAbandonReasons.has(reason)) throw new TypeError('outbox abandoned reason is unsupported')
  return Object.freeze({ messageId: messageReference(record), reason })
}

function decodeInboxAccepted(value: JsonValue): InboxAcceptedPayload {
  const record = requireRecord(value, 'inbox accepted payload')
  requireExactKeys(record, ['envelope', 'digest'], [], 'inbox accepted payload')
  const digest = requireString(record.digest, 'inbox accepted digest')
  if (!DIGEST_PATTERN.test(digest)) throw new TypeError('inbox accepted digest is not canonical')
  return Object.freeze({ envelope: decodeMessageEnvelope(record.envelope as JsonValue), digest })
}

function decodeInboxProcessed(value: JsonValue): InboxProcessedPayload {
  const record = requireRecord(value, 'inbox processed payload')
  requireExactKeys(record, ['messageId'], [], 'inbox processed payload')
  return Object.freeze({ messageId: messageReference(record) })
}

function decodeInboxAbandoned(value: JsonValue): InboxAbandonedPayload {
  const record = requireRecord(value, 'inbox abandoned payload')
  requireExactKeys(record, ['messageId', 'reason'], [], 'inbox abandoned payload')
  const reason = requireString(record.reason, 'inbox abandoned reason') as InboxAbandonReason
  if (!inboxAbandonReasons.has(reason)) throw new TypeError('inbox abandoned reason is unsupported')
  return Object.freeze({ messageId: messageReference(record), reason })
}

/** Durable Definition for initial Outbox acceptance. */
export const outboxAcceptedEvent = createDurableEventDefinition<OutboxAcceptedPayload>({
  type: 'communication/outbox-accepted', payloadVersion: 1, ignorable: false, decode: decodeAccepted,
})
/** Durable Definition for a delivery attempt started before Transport invocation. */
export const outboxAttemptStartedEvent = createDurableEventDefinition<OutboxAttemptStartedPayload>({
  type: 'communication/outbox-attempt-started', payloadVersion: 1, ignorable: false, decode: decodeAttemptStarted,
})
/** Durable Definition for a retryable delivery attempt result. */
export const outboxAttemptFailedEvent = createDurableEventDefinition<OutboxAttemptFailedPayload>({
  type: 'communication/outbox-attempt-failed', payloadVersion: 1, ignorable: false, decode: decodeAttemptFailed,
})
/** Durable Definition for a recipient Inbox commit receipt. */
export const outboxDeliveredEvent = createDurableEventDefinition<OutboxDeliveredPayload>({
  type: 'communication/outbox-delivered', payloadVersion: 1, ignorable: false, decode: decodeDelivered,
})
/** Durable Definition for a terminal remote delivery rejection. */
export const outboxRejectedEvent = createDurableEventDefinition<OutboxRejectedPayload>({
  type: 'communication/outbox-rejected', payloadVersion: 1, ignorable: false, decode: decodeRejected,
})
/** Durable Definition for a local stop to future delivery attempts. */
export const outboxAbandonedEvent = createDurableEventDefinition<OutboxAbandonedPayload>({
  type: 'communication/outbox-abandoned', payloadVersion: 1, ignorable: false, decode: decodeOutboxAbandoned,
})
/** Durable Definition for first idempotent Inbox acceptance. */
export const inboxAcceptedEvent = createDurableEventDefinition<InboxAcceptedPayload>({
  type: 'communication/inbox-accepted', payloadVersion: 1, ignorable: false, decode: decodeInboxAccepted,
})
/** Durable Definition for successful local Inbox settlement. */
export const inboxProcessedEvent = createDurableEventDefinition<InboxProcessedPayload>({
  type: 'communication/inbox-processed', payloadVersion: 1, ignorable: false, decode: decodeInboxProcessed,
})
/** Durable Definition for a local decision to stop Inbox processing. */
export const inboxAbandonedEvent = createDurableEventDefinition<InboxAbandonedPayload>({
  type: 'communication/inbox-abandoned', payloadVersion: 1, ignorable: false, decode: decodeInboxAbandoned,
})

/** Required Durable Event Definitions contributed by Session communication. */
export const communicationSessionEventDefinitions: readonly DurableEventDefinition[] = Object.freeze([
  outboxAcceptedEvent,
  keyedOutboxAcceptedEvent,
  outboxAttemptStartedEvent,
  outboxAttemptFailedEvent,
  outboxDeliveredEvent,
  outboxRejectedEvent,
  outboxAbandonedEvent,
  inboxAcceptedEvent,
  inboxProcessedEvent,
  inboxAbandonedEvent,
])

import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { SessionAddress, SessionEventId, SessionId, SessionSequence } from '../session/index.js'
import type { ChannelId, ChannelSequence, MessageId } from './ids.js'

/** Current outer Message Envelope version. */
export const MESSAGE_ENVELOPE_VERSION = 1 as const

/** Retry outcomes that leave an Outbox message eligible for another attempt. */
export type MessageRetryCode =
  | 'recipient-offline'
  | 'recipient-ending'
  | 'recipient-backpressure'
  | 'attempt-interrupted'
  | 'receiver-outcome-unknown'
  | 'transport-outcome-unknown'

/** Terminal outcomes explicitly reported by a receiver or authoritative Directory. */
export type MessageRejectionCode =
  | 'recipient-unknown'
  | 'recipient-ended'
  | 'receive-forbidden'
  | 'message-unsupported'
  | 'payload-invalid'
  | 'message-id-conflict'

/** Local reason for stopping an accepted Outbox message. */
export type OutboxAbandonReason = 'caller-requested' | 'attempts-exhausted'

/** Local reason for declining further processing of an Inbox message. */
export type InboxAbandonReason = 'caller-requested' | 'unsupported-message'

/** Immutable versioned message exchanged between Session mailboxes. */
export interface MessageEnvelope<TPayload extends JsonValue = JsonValue> extends JsonObject {
  readonly envelopeVersion: typeof MESSAGE_ENVELOPE_VERSION
  readonly messageId: MessageId
  readonly sender: SessionAddress
  readonly recipient: SessionAddress
  readonly channelId: ChannelId
  readonly channelSequence: ChannelSequence
  readonly correlationId: MessageId
  readonly causationId?: MessageId
  readonly replyTo?: MessageId
  readonly createdAt: string
  readonly type: string
  readonly payloadVersion: number
  readonly payload: TPayload
}

/** Explicit root or causally derived send request. */
export type MessageSendRequest =
  | {
    readonly kind: 'root'
    readonly recipient: SessionAddress
    readonly channelId: ChannelId
  }
  | {
    readonly kind: 'derived'
    readonly recipient: SessionAddress
    readonly channelId: ChannelId
    readonly correlationId: MessageId
    readonly causationId: MessageId
  }

/** Receipt proving that a recipient Session committed its Inbox event. */
export interface MessageDeliveryReceipt extends JsonObject {
  readonly messageId: MessageId
  readonly recipient: SessionAddress
  readonly inboxEventId: SessionEventId
}

/** One transport delivery result with explicit retry and terminal categories. */
export type MessageDeliveryOutcome =
  | { readonly kind: 'accepted'; readonly receipt: MessageDeliveryReceipt }
  | { readonly kind: 'retry'; readonly code: MessageRetryCode }
  | { readonly kind: 'rejected'; readonly code: MessageRejectionCode }

/** Resource bounds applied by a Communication Service. */
export interface MailboxLimits {
  readonly maxMessageBytes: number
  readonly maxPendingOutbox: number
  readonly maxPendingInbox: number
  readonly maxDeliveryAttempts: number
  readonly maxAttemptsPerRun: number
}

/** Input supplied to an outgoing communication policy. */
export interface OutgoingMessagePolicyInput {
  readonly sender: SessionAddress
  readonly recipient: SessionAddress
  readonly channelId: ChannelId
  readonly type: string
  readonly payloadVersion: number
}

/** Input supplied to an incoming communication policy. */
export interface IncomingMessagePolicyInput extends OutgoingMessagePolicyInput {
  readonly authenticatedSender: SessionAddress
}

/** One deterministic communication authorization decision. */
export type MessagePolicyDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reasonCode: string }

/** Immutable policy used for one Mailbox attachment lifetime. */
export interface CommunicationPolicy {
  /** Decide whether a new local Outbox record may be accepted. */
  canSend(input: OutgoingMessagePolicyInput): MessagePolicyDecision
  /** Decide whether a new remote Inbox record may be accepted. */
  canReceive(input: IncomingMessagePolicyInput): MessagePolicyDecision
}

/** Policy that permits every structurally valid message. */
export const allowAllCommunicationPolicy: CommunicationPolicy = Object.freeze({
  canSend: () => Object.freeze({ kind: 'allow' as const }),
  canReceive: () => Object.freeze({ kind: 'allow' as const }),
})

/** One accepted Outbox record returned by send or reply. */
export interface OutgoingMessageAccepted<TPayload extends JsonValue = JsonValue> {
  readonly messageId: MessageId
  readonly envelope: MessageEnvelope<TPayload>
  readonly outboxEventId: SessionEventId
}

/** Last retryable outcome recorded for an Outbox message. */
export interface OutboxFailureSnapshot extends JsonObject {
  readonly attempt: number
  readonly code: MessageRetryCode
  readonly eventId: SessionEventId
}

interface OutboxSnapshotBase {
  readonly messageId: MessageId
  readonly envelope: MessageEnvelope
  readonly acceptedEventId: SessionEventId
  readonly acceptedSequence: SessionSequence
  readonly attemptCount: number
  readonly openAttempt?: number
  readonly lastFailure?: OutboxFailureSnapshot
}

/** Reconstructed state of one sender-owned Outbox message. */
export type OutboxMessageSnapshot = OutboxSnapshotBase & (
  | { readonly status: 'pending' }
  | { readonly status: 'delivered'; readonly receipt: MessageDeliveryReceipt; readonly terminalEventId: SessionEventId }
  | { readonly status: 'rejected'; readonly rejection: MessageRejectionCode; readonly terminalEventId: SessionEventId }
  | { readonly status: 'abandoned'; readonly abandonReason: OutboxAbandonReason; readonly terminalEventId: SessionEventId }
)

interface InboxSnapshotBase {
  readonly messageId: MessageId
  readonly envelope: MessageEnvelope
  readonly digest: string
  readonly acceptedEventId: SessionEventId
  readonly acceptedSequence: SessionSequence
  readonly supported: boolean
}

/** Reconstructed state of one recipient-owned Inbox message. */
export type InboxMessageSnapshot = InboxSnapshotBase & (
  | { readonly status: 'pending' }
  | { readonly status: 'processed'; readonly terminalEventId: SessionEventId }
  | { readonly status: 'abandoned'; readonly abandonReason: InboxAbandonReason; readonly terminalEventId: SessionEventId }
)

/** Immutable communication projection for one Session's local history segment. */
export interface MailboxSnapshot {
  readonly sessionId: SessionId
  readonly address: SessionAddress
  readonly outbox: readonly OutboxMessageSnapshot[]
  readonly inbox: readonly InboxMessageSnapshot[]
  readonly unsupportedInbox: readonly MessageId[]
}

/** Process-local Mailbox lifecycle state. */
export type SessionMailboxStatus = 'open' | 'ending' | 'ended' | 'faulted' | 'disposed'

/** Frozen counters describing one explicit Dispatcher run. */
export interface OutboxDispatchReport {
  readonly startedAttempts: number
  readonly delivered: number
  readonly rejected: number
  readonly retryable: number
  readonly abandoned: number
  readonly remainingPending: number
  readonly stoppedBy: 'idle' | 'run-budget' | 'aborted' | 'mailbox-inactive'
}

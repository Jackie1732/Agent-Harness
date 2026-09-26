import type { WorkflowChannels } from './workflow-channels.js'
import type { DelegationChannels } from './delegation-channels.js'
import type { Clock } from '../foundation/index.js'
import { SerialGate } from '../foundation/serial-gate.js'
import type { SessionAddress, SessionHandle } from '../session/index.js'
import { SessionError } from '../session/index.js'
import { canonicalJsonBytes, equalMessageEnvelopes, messageEnvelopeDigest } from './canonical-json.js'
import { evaluatePolicyDecision } from './configuration.js'
import { decodeMessageEnvelope } from './envelope.js'
import { CommunicationError } from './errors.js'
import type { CommunicationIdentitySource, MessageId } from './ids.js'
import type { MessageCatalog } from './message-catalog.js'
import { decodeMessagePayload } from './message-catalog.js'
import { projectMailbox } from './projection.js'
import { inboxAbandonedEvent, inboxAcceptedEvent, inboxProcessedEvent } from './session-events.js'
import type {
  CommunicationPolicy,
  InboxAbandonReason,
  InboxMessageSnapshot,
  MailboxLimits,
  MailboxSnapshot,
  MessageDeliveryOutcome,
  MessageEnvelope,
} from './types.js'

/** Dependencies of the private durable Mailbox transition owner. */
export interface MailboxJournalOptions {
  readonly channels?: DelegationChannels
  readonly workflowChannels?: WorkflowChannels
  readonly handle: SessionHandle
  readonly catalog: MessageCatalog
  readonly policy: CommunicationPolicy
  readonly limits: MailboxLimits
  readonly clock: Clock
  readonly identitySource: CommunicationIdentitySource
  readonly fault: () => void
}

function pendingCount<T extends { readonly status: string }>(items: readonly T[]): number {
  return items.filter(item => item.status === 'pending').length
}

function inboxReceipt(message: InboxMessageSnapshot) {
  return Object.freeze({
    messageId: message.messageId,
    recipient: message.envelope.recipient,
    inboxEventId: message.acceptedEventId,
  })
}

/** Serializes checks with the exact durable Inbox or Outbox transition they authorize. */
export class MailboxJournal {
  readonly #options: MailboxJournalOptions
  readonly #receiveGate = new SerialGate()

  constructor(options: MailboxJournalOptions) {
    this.#options = options
  }

  snapshot(): MailboxSnapshot {
    return projectMailbox(this.#options.handle.snapshot(), this.#options.catalog)
  }

  acceptDelivery(
    envelope: MessageEnvelope,
    authenticatedSender: SessionAddress,
    acceptNew: boolean,
  ): Promise<MessageDeliveryOutcome> {
    return this.#receiveGate.run(() => this.#options.channels === undefined ? this.#receive(envelope, authenticatedSender, acceptNew)
      : this.#options.channels.run(() => this.#receive(envelope, authenticatedSender, acceptNew)))
  }

  settleInbox(
    messageId: MessageId,
    action: 'processed' | 'abandoned',
    reason?: InboxAbandonReason,
  ): Promise<InboxMessageSnapshot> {
    return this.#receiveGate.run(() => this.#commitInboxStatus(messageId, action, reason))
  }

  async drain(): Promise<void> {
    await this.#receiveGate.drain()
  }

  async #receive(
    envelopeInput: MessageEnvelope,
    authenticatedSender: SessionAddress,
    acceptNew: boolean,
  ): Promise<MessageDeliveryOutcome> {
    let envelope: MessageEnvelope
    try {
      envelope = decodeMessageEnvelope(envelopeInput)
    } catch {
      return Object.freeze({ kind: 'rejected', code: 'payload-invalid' })
    }
    if (envelope.sender !== authenticatedSender || envelope.recipient !== this.#options.handle.header.address) {
      return Object.freeze({ kind: 'rejected', code: 'receive-forbidden' })
    }
    const snapshot = this.snapshot()
    const existing = snapshot.inbox.find(item => item.messageId === envelope.messageId)
    if (existing !== undefined) {
      return existing.digest === messageEnvelopeDigest(envelope) && equalMessageEnvelopes(existing.envelope, envelope)
        ? Object.freeze({ kind: 'accepted', receipt: inboxReceipt(existing) })
        : Object.freeze({ kind: 'rejected', code: 'message-id-conflict' })
    }
    if (!acceptNew) return Object.freeze({ kind: 'retry', code: 'recipient-ending' })
    const definition = this.#options.catalog.resolve(envelope.type, envelope.payloadVersion)
    if (definition === undefined) return Object.freeze({ kind: 'rejected', code: 'message-unsupported' })
    try {
      decodeMessagePayload(definition, envelope.payload)
    } catch {
      return Object.freeze({ kind: 'rejected', code: 'payload-invalid' })
    }
    if (canonicalJsonBytes(envelope).byteLength > this.#options.limits.maxMessageBytes) {
      return Object.freeze({ kind: 'rejected', code: 'payload-invalid' })
    }
    const decision = evaluatePolicyDecision(() => this.#options.policy.canReceive({
      sender: envelope.sender,
      authenticatedSender,
      recipient: envelope.recipient,
      channelId: envelope.channelId,
      type: envelope.type,
      payloadVersion: envelope.payloadVersion,
    }))
    const workflow = envelope.type.startsWith('workflow/')
    const protocol = envelope.type.startsWith('subagent/')
    if (workflow ? !this.#options.workflowChannels?.authorizeReceive(envelope) : protocol ? !this.#options.channels?.authorizeReceive(envelope) : decision.kind === 'deny') return Object.freeze({ kind: 'rejected', code: 'receive-forbidden' })
    if (this.#options.channels !== undefined ? !this.#options.channels.hasCapacity(this.#options.handle, 'inbox', envelope)
      : pendingCount(snapshot.inbox) >= this.#options.limits.maxPendingInbox) {
      return Object.freeze({ kind: 'retry', code: 'recipient-backpressure' })
    }
    try {
      const event = await this.#options.handle.append(inboxAcceptedEvent, {
        envelope,
        digest: messageEnvelopeDigest(envelope),
      })
      return Object.freeze({
        kind: 'accepted',
        receipt: Object.freeze({
          messageId: envelope.messageId,
          recipient: this.#options.handle.header.address,
          inboxEventId: event.stored.eventId,
        }),
      })
    } catch (cause) {
      if (cause instanceof SessionError && cause.code === 'SESSION_APPEND_OUTCOME_UNKNOWN') {
        this.#options.fault()
        throw new CommunicationError('MESSAGE_INBOX_COMMIT_UNKNOWN', 'Inbox commit outcome is unknown', {
          details: { messageId: envelope.messageId }, cause,
        })
      }
      throw cause
    }
  }

  async #commitInboxStatus(
    messageId: MessageId,
    action: 'processed' | 'abandoned',
    reason?: InboxAbandonReason,
  ): Promise<InboxMessageSnapshot> {
    const existing = this.snapshot().inbox.find(item => item.messageId === messageId)
    if (existing === undefined) {
      throw new CommunicationError('MESSAGE_NOT_FOUND', 'Inbox message does not exist', { details: { messageId } })
    }
    if (action === 'processed' && existing.status === 'processed') return existing
    if (action === 'abandoned' && existing.status === 'abandoned' && existing.abandonReason === reason) return existing
    if (existing.status !== 'pending') {
      throw new CommunicationError('MESSAGE_STATE_INVALID', 'Inbox message already has another terminal state', {
        details: { messageId, status: existing.status },
      })
    }
    if (action === 'processed' && !existing.supported) {
      throw new CommunicationError('MESSAGE_STATE_INVALID', 'unsupported Inbox message cannot be processed', {
        details: { messageId },
      })
    }
    try {
      if (action === 'processed') await this.#options.handle.append(inboxProcessedEvent, { messageId })
      else await this.#options.handle.append(inboxAbandonedEvent, { messageId, reason: reason! })
    } catch (cause) {
      if (cause instanceof SessionError && cause.code === 'SESSION_APPEND_OUTCOME_UNKNOWN') {
        this.#options.fault()
        throw new CommunicationError('MESSAGE_INBOX_STATUS_COMMIT_UNKNOWN', 'Inbox status commit outcome is unknown', {
          details: { messageId, action }, cause,
        })
      }
      throw cause
    }
    const committed = this.snapshot().inbox.find(item => item.messageId === messageId)
    if (committed === undefined) {
      throw new CommunicationError('MESSAGE_STATE_INVALID', 'committed Inbox status is missing from projection', {
        details: { messageId, action },
      })
    }
    return committed
  }
}

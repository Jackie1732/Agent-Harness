import { systemClock } from '../foundation/clock.js'
import type { Clock, JsonValue } from '../foundation/index.js'
import type {
  CommittedSessionEvent,
  SessionAddress,
  SessionEndedPayload,
  SessionHandle,
  SessionId,
} from '../session/index.js'
import type { DirectoryReceiver } from './directory.js'
import { CommunicationError } from './errors.js'
import type { CommunicationIdentitySource, MessageId } from './ids.js'
import { parseMessageId, systemCommunicationIdentitySource } from './ids.js'
import { MailboxJournal } from './mailbox-journal.js'
import type { MessageCatalog, MessageDefinition } from './message-catalog.js'
import { decodeMessagePayload } from './message-catalog.js'
import { OutboxAttemptCoordinator } from './outbox-attempts.js'
import { OutboxAcceptance } from './outbox-acceptance.js'
import type { MessageCommandContent, MessageSendKey } from './send-command.js'
import type { DeliveryAttemptLease, PrepareAttemptResult } from './outbox-attempts.js'
import type {
  CommunicationPolicy,
  InboxAbandonReason,
  InboxMessageSnapshot,
  MailboxLimits,
  MailboxSnapshot,
  MessageDeliveryOutcome,
  MessageEnvelope,
  MessageSendRequest,
  OutboxAbandonReason,
  OutboxMessageSnapshot,
  OutgoingMessageAccepted,
  SessionMailboxStatus,
} from './types.js'

/** Public local communication port bound to one Session Handle. */
export interface SessionMailbox {
  /** Accept one durable local command, or return its original acceptance without new authorization. */
  sendOnce(key: MessageSendKey, request: MessageSendRequest, content: MessageCommandContent): Promise<OutgoingMessageAccepted>
  /** Idempotent reply; the original Inbox owns recipient and causation fields. */
  replyOnce(key: MessageSendKey, inboxMessageId: MessageId, content: MessageCommandContent): Promise<OutgoingMessageAccepted>
  readonly sessionId: SessionId
  readonly address: SessionAddress
  readonly status: SessionMailboxStatus
  /** Commit one immutable root or derived message to the local Outbox. */
  send<TPayload extends JsonValue>(
    definition: MessageDefinition<TPayload>,
    request: MessageSendRequest,
    payload: JsonValue,
  ): Promise<OutgoingMessageAccepted<TPayload>>
  /** Commit a causally linked reply to one locally accepted Inbox message. */
  reply<TPayload extends JsonValue>(
    inboxMessageId: MessageId,
    definition: MessageDefinition<TPayload>,
    payload: JsonValue,
  ): Promise<OutgoingMessageAccepted<TPayload>>
  /** Mark one supported Inbox message as processed. */
  markProcessed(messageId: MessageId): Promise<InboxMessageSnapshot>
  /** Persist a local decision to stop processing one Inbox message. */
  abandonIncoming(messageId: MessageId, reason: InboxAbandonReason): Promise<InboxMessageSnapshot>
  /** Persist a local decision to stop attempts for one Outbox message. */
  abandonOutgoing(messageId: MessageId, reason: OutboxAbandonReason): Promise<OutboxMessageSnapshot>
  /** Reconstruct current communication state from the Session log. */
  snapshot(): MailboxSnapshot
  /** End the Session only after all local Inbox and Outbox work is terminal. */
  endSession(reason?: string): Promise<CommittedSessionEvent<SessionEndedPayload>>
  /** Stop process-local communication while retaining every durable fact. */
  dispose(): Promise<void>
}

/** Dependencies supplied only by Communication Service attachment. */
export interface SessionMailboxOptions {
  readonly handle: SessionHandle
  readonly catalog: MessageCatalog
  readonly policy: CommunicationPolicy
  readonly limits: MailboxLimits
  readonly clock?: Clock
  readonly identitySource?: CommunicationIdentitySource
  readonly onEnded: () => void
  readonly onDispose: () => Promise<void>
}

function inactive(status: SessionMailboxStatus, address: SessionAddress): CommunicationError {
  return new CommunicationError('MESSAGE_MAILBOX_INACTIVE', `Session Mailbox is ${status}`, {
    details: { address, status },
  })
}

function pendingCount<T extends { readonly status: string }>(items: readonly T[]): number {
  return items.filter(item => item.status === 'pending').length
}

/** Coordinates Mailbox acceptance, lifecycle, and durable transition owners. */
export class SessionMailboxImpl implements SessionMailbox, DirectoryReceiver {
  readonly #handle: SessionHandle
  readonly #catalog: MessageCatalog
  readonly #limits: MailboxLimits
  readonly #onEnded: () => void
  readonly #onDispose: () => Promise<void>
  readonly #operations = new Set<Promise<unknown>>()
  readonly #disposalController = new AbortController()
  readonly #journal: MailboxJournal
  readonly #outbox: OutboxAcceptance
  readonly #attempts: OutboxAttemptCoordinator
  #status: SessionMailboxStatus = 'open'
  #disposeTask: Promise<void> | undefined
  #endingTask: Promise<CommittedSessionEvent<SessionEndedPayload>> | undefined

  constructor(options: SessionMailboxOptions) {
    this.#handle = options.handle
    this.#catalog = options.catalog
    this.#limits = options.limits
    this.#onEnded = options.onEnded
    this.#onDispose = options.onDispose
    const clock = options.clock ?? systemClock
    const identitySource = options.identitySource ?? systemCommunicationIdentitySource
    const journalOptions = {
      handle: this.#handle,
      catalog: this.#catalog,
      policy: options.policy,
      limits: this.#limits,
      clock,
      identitySource,
      fault: () => this.fault(),
    }
    this.#journal = new MailboxJournal(journalOptions)
    this.#outbox = new OutboxAcceptance(journalOptions)
    this.#attempts = new OutboxAttemptCoordinator({
      handle: this.#handle,
      catalog: this.#catalog,
      maxDeliveryAttempts: this.#limits.maxDeliveryAttempts,
      disposalSignal: this.#disposalController.signal,
      canStart: () => this.#status === 'open',
      fault: () => this.fault(),
    })
  }

  get sessionId(): SessionId { return this.#handle.header.sessionId }
  get address(): SessionAddress { return this.#handle.header.address }
  get status(): SessionMailboxStatus { return this.#status }
  get limits(): MailboxLimits { return this.#limits }

  send<TPayload extends JsonValue>(
    definition: MessageDefinition<TPayload>,
    request: MessageSendRequest,
    payload: JsonValue,
  ): Promise<OutgoingMessageAccepted<TPayload>> {
    this.#assertAccepting()
    this.#assertDefinition(definition)
    const decoded = decodeMessagePayload(definition, payload)
    return this.#track(this.#outbox.send(definition, request, decoded))
  }

  reply<TPayload extends JsonValue>(
    inboxMessageId: MessageId,
    definition: MessageDefinition<TPayload>,
    payload: JsonValue,
  ): Promise<OutgoingMessageAccepted<TPayload>> {
    this.#assertAccepting()
    parseMessageId(inboxMessageId)
    this.#assertDefinition(definition)
    const decoded = decodeMessagePayload(definition, payload)
    return this.#track(this.#outbox.reply(inboxMessageId, definition, decoded))
  }

  sendOnce(key: MessageSendKey, request: MessageSendRequest, content: MessageCommandContent): Promise<OutgoingMessageAccepted> {
    this.#assertAccepting()
    return this.#track(this.#outbox.sendOnce(key, { ...content, kind: 'send', request }))
  }

  replyOnce(key: MessageSendKey, inboxMessageId: MessageId, content: MessageCommandContent): Promise<OutgoingMessageAccepted> {
    this.#assertAccepting()
    return this.#track(this.#outbox.sendOnce(key, { ...content, kind: 'reply', inboxMessageId }))
  }

  markProcessed(messageId: MessageId): Promise<InboxMessageSnapshot> {
    this.#assertAccepting()
    parseMessageId(messageId)
    return this.#track(this.#journal.settleInbox(messageId, 'processed'))
  }

  abandonIncoming(messageId: MessageId, reason: InboxAbandonReason): Promise<InboxMessageSnapshot> {
    this.#assertAccepting()
    parseMessageId(messageId)
    if (reason !== 'caller-requested' && reason !== 'unsupported-message') {
      throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'Inbox abandon reason is invalid')
    }
    return this.#track(this.#journal.settleInbox(messageId, 'abandoned', reason))
  }

  abandonOutgoing(messageId: MessageId, reason: OutboxAbandonReason): Promise<OutboxMessageSnapshot> {
    this.#assertAccepting()
    parseMessageId(messageId)
    if (reason !== 'caller-requested' && reason !== 'attempts-exhausted') {
      throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'Outbox abandon reason is invalid')
    }
    return this.#track(this.#attempts.abandon(messageId, reason))
  }

  snapshot(): MailboxSnapshot {
    if (this.#status === 'disposed') throw inactive(this.#status, this.address)
    return this.#journal.snapshot()
  }

  endSession(reason?: string): Promise<CommittedSessionEvent<SessionEndedPayload>> {
    if (this.#endingTask !== undefined) return this.#endingTask
    if (this.#status === 'ended') return this.#handle.end(reason)
    this.#assertAccepting()
    this.#status = 'ending'
    const task = (async () => {
      try {
        await Promise.allSettled([...this.#operations])
        await Promise.all([this.#journal.drain(), this.#attempts.drain()])
        const snapshot = this.#journal.snapshot()
        const pendingOutbox = pendingCount(snapshot.outbox)
        const pendingInbox = pendingCount(snapshot.inbox)
        if (pendingOutbox > 0 || pendingInbox > 0) {
          throw new CommunicationError('MESSAGE_PENDING', 'Session has pending communication', {
            details: { address: this.address, pendingOutbox, pendingInbox },
          })
        }
        const event = await this.#handle.end(reason)
        this.#status = 'ended'
        this.#onEnded()
        return event
      } catch (cause) {
        if (this.#status === 'ending') this.#status = 'open'
        throw cause
      } finally {
        this.#endingTask = undefined
      }
    })()
    this.#endingTask = this.#track(task)
    return this.#endingTask
  }

  dispose(): Promise<void> {
    if (this.#disposeTask !== undefined) return this.#disposeTask
    this.#status = 'disposed'
    this.#disposalController.abort()
    const task = (async () => {
      await Promise.allSettled([...this.#operations])
      await Promise.all([this.#journal.drain(), this.#attempts.drain()])
      await this.#onDispose()
      this.#status = 'disposed'
    })()
    this.#disposeTask = task
    return task
  }

  verifyDeliveryAttempt(envelope: MessageEnvelope): boolean {
    return this.#attempts.verify(envelope)
  }

  acceptDelivery(
    envelope: MessageEnvelope,
    authenticatedSender: SessionAddress,
    signal: AbortSignal,
  ): Promise<MessageDeliveryOutcome> {
    if (this.#status === 'ended') return Promise.resolve(Object.freeze({ kind: 'rejected', code: 'recipient-ended' }))
    if ((this.#status !== 'open' && this.#status !== 'ending') || signal.aborted) {
      return Promise.resolve(Object.freeze({ kind: 'retry', code: 'receiver-outcome-unknown' }))
    }
    return this.#track(this.#journal.acceptDelivery(envelope, authenticatedSender, this.#status === 'open'))
  }

  prepareAttempt(messageId: MessageId, signal?: AbortSignal): Promise<PrepareAttemptResult> {
    return this.#attempts.prepare(messageId, signal)
  }

  completeAttempt(
    lease: DeliveryAttemptLease,
    outcome: MessageDeliveryOutcome,
  ): Promise<'delivered' | 'rejected' | 'retryable' | 'abandoned'> {
    return this.#attempts.complete(lease, outcome)
  }

  currentSnapshot(): MailboxSnapshot {
    return this.#journal.snapshot()
  }

  fault(): void {
    if (this.#status === 'open' || this.#status === 'ending') {
      this.#status = 'faulted'
      this.#disposalController.abort()
    }
  }

  #assertDefinition(definition: MessageDefinition): void {
    if (!this.#catalog.contains(definition)) {
      throw new CommunicationError('MESSAGE_DEFINITION_UNREGISTERED', 'Message Definition is not in this Mailbox Catalog', {
        details: { type: definition.type, payloadVersion: definition.payloadVersion },
      })
    }
  }

  #assertAccepting(): void {
    if (this.#status !== 'open') throw inactive(this.#status, this.address)
  }

  #track<T>(task: Promise<T>): Promise<T> {
    this.#operations.add(task)
    void task.finally(() => this.#operations.delete(task)).catch(() => undefined)
    return task
  }
}

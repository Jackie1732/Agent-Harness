import { SerialGate } from '../foundation/serial-gate.js'
import { assertNever } from '../foundation/never.js'
import type { SessionHandle } from '../session/index.js'
import { parseSessionAddress, parseSessionEventId, SessionError } from '../session/index.js'
import { equalMessageEnvelopes } from './canonical-json.js'
import { CommunicationError } from './errors.js'
import type { MessageId } from './ids.js'
import { projectMailbox } from './projection.js'
import {
  outboxAbandonedEvent,
  outboxAttemptFailedEvent,
  outboxAttemptStartedEvent,
  outboxDeliveredEvent,
  outboxRejectedEvent,
} from './session-events.js'
import type { MessageCatalog } from './message-catalog.js'
import type {
  MessageDeliveryOutcome,
  MessageEnvelope,
  OutboxAbandonReason,
  OutboxMessageSnapshot,
} from './types.js'

/** Private proof that one persisted attempt is the active Channel head. */
export interface DeliveryAttemptLease {
  readonly messageId: MessageId
  readonly attempt: number
  readonly envelope: MessageEnvelope
  readonly signal: AbortSignal
}

/** Result of checking and optionally committing the next delivery attempt. */
export type PrepareAttemptResult =
  | { readonly kind: 'started'; readonly lease: DeliveryAttemptLease }
  | { readonly kind: 'ineligible' }
  | { readonly kind: 'exhausted' }

interface ActiveAttempt {
  readonly lease: DeliveryAttemptLease
  readonly settled: Promise<void>
  settle(): void
}

/** Dependencies of the private Outbox attempt state owner. */
export interface OutboxAttemptCoordinatorOptions {
  readonly handle: SessionHandle
  readonly catalog: MessageCatalog
  readonly maxDeliveryAttempts: number
  readonly disposalSignal: AbortSignal
  readonly canStart: () => boolean
  readonly fault: () => void
}

function channelKey(envelope: MessageEnvelope): string {
  return `${envelope.recipient}\u0000${envelope.channelId}`
}

function makeActive(envelope: MessageEnvelope, attempt: number, signal: AbortSignal): ActiveAttempt {
  let settle!: () => void
  const settled = new Promise<void>(resolve => { settle = resolve })
  return {
    lease: Object.freeze({ messageId: envelope.messageId, attempt, envelope, signal }),
    settled,
    settle,
  }
}

function normalizeOutcome(lease: DeliveryAttemptLease, outcome: MessageDeliveryOutcome): MessageDeliveryOutcome {
  if (outcome.kind !== 'accepted') return outcome
  const receipt = outcome.receipt
  try {
    const recipientId = parseSessionAddress(lease.envelope.recipient)
    if (
      receipt.messageId === lease.messageId
      && receipt.recipient === lease.envelope.recipient
      && parseSessionEventId(receipt.inboxEventId).sessionId === recipientId
    ) return outcome
  } catch {
    // A provider must not turn an invalid or unrelated receipt into a durable delivery fact.
  }
  return Object.freeze({ kind: 'retry', code: 'transport-outcome-unknown' })
}

/** Owns persisted delivery attempts and their process-local exclusive leases. */
export class OutboxAttemptCoordinator {
  readonly #options: OutboxAttemptCoordinatorOptions
  readonly #gate = new SerialGate()
  readonly #active = new Map<MessageId, ActiveAttempt>()
  readonly #blocked = new Set<MessageId>()

  constructor(options: OutboxAttemptCoordinatorOptions) {
    this.#options = options
  }

  /** Start the next persisted attempt when the message is still an eligible Channel head. */
  prepare(messageId: MessageId, callerSignal?: AbortSignal): Promise<PrepareAttemptResult> {
    return this.#gate.run(async () => {
      if (!this.#options.canStart() || callerSignal?.aborted === true) return Object.freeze({ kind: 'ineligible' as const })
      let snapshot = projectMailbox(this.#options.handle.snapshot(), this.#options.catalog)
      let message = snapshot.outbox.find(item => item.messageId === messageId)
      if (message?.status !== 'pending' || this.#active.has(messageId) || this.#blocked.has(messageId)) {
        return Object.freeze({ kind: 'ineligible' as const })
      }
      if (!this.#isChannelHead(message, snapshot.outbox)) return Object.freeze({ kind: 'ineligible' as const })

      if (message.openAttempt !== undefined) {
        await this.#appendStatus(outboxAttemptFailedEvent, {
          messageId,
          attempt: message.openAttempt,
          code: 'transport-outcome-unknown',
        })
        snapshot = projectMailbox(this.#options.handle.snapshot(), this.#options.catalog)
        message = snapshot.outbox.find(item => item.messageId === messageId)
        if (message?.status !== 'pending') return Object.freeze({ kind: 'ineligible' as const })
      }
      if (message.attemptCount >= this.#options.maxDeliveryAttempts) {
        await this.#appendStatus(outboxAbandonedEvent, { messageId, reason: 'attempts-exhausted' })
        return Object.freeze({ kind: 'exhausted' as const })
      }
      const attempt = message.attemptCount + 1
      await this.#appendStatus(outboxAttemptStartedEvent, { messageId, attempt })
      const signal = callerSignal === undefined
        ? this.#options.disposalSignal
        : AbortSignal.any([callerSignal, this.#options.disposalSignal])
      const active = makeActive(message.envelope, attempt, signal)
      this.#active.set(messageId, active)
      return Object.freeze({ kind: 'started' as const, lease: active.lease })
    })
  }

  /** Stop future attempts after any active attempt for this message settles. */
  async abandon(messageId: MessageId, reason: OutboxAbandonReason): Promise<OutboxMessageSnapshot> {
    this.#blocked.add(messageId)
    try {
      while (true) {
        const result = await this.#gate.run(async (): Promise<OutboxMessageSnapshot | ActiveAttempt> => {
          const active = this.#active.get(messageId)
          if (active !== undefined) return active
          let message = projectMailbox(this.#options.handle.snapshot(), this.#options.catalog)
            .outbox.find(item => item.messageId === messageId)
          if (message === undefined) {
            throw new CommunicationError('MESSAGE_NOT_FOUND', 'Outbox message does not exist', { details: { messageId } })
          }
          if (message.status === 'abandoned' && message.abandonReason === reason) return message
          if (message.status !== 'pending') {
            throw new CommunicationError('MESSAGE_STATE_INVALID', 'Outbox message already has another terminal state', {
              details: { messageId, status: message.status },
            })
          }
          if (message.openAttempt !== undefined) {
            await this.#appendStatus(outboxAttemptFailedEvent, {
              messageId,
              attempt: message.openAttempt,
              code: 'transport-outcome-unknown',
            })
            message = projectMailbox(this.#options.handle.snapshot(), this.#options.catalog)
              .outbox.find(item => item.messageId === messageId)
            if (message?.status !== 'pending') {
              throw new CommunicationError('MESSAGE_STATE_INVALID', 'recovered Outbox attempt did not settle as pending', {
                details: { messageId },
              })
            }
          }
          await this.#appendStatus(outboxAbandonedEvent, { messageId, reason })
          const committed = projectMailbox(this.#options.handle.snapshot(), this.#options.catalog)
            .outbox.find(item => item.messageId === messageId)
          if (committed === undefined) {
            throw new CommunicationError('MESSAGE_STATE_INVALID', 'committed Outbox abandonment is missing from projection', {
              details: { messageId, reason },
            })
          }
          return committed
        })
        if ('settled' in result) {
          await result.settled
          continue
        }
        return result
      }
    } finally {
      this.#blocked.delete(messageId)
    }
  }

  /** Wait for persisted attempt transitions and every active Transport call to settle. */
  async drain(): Promise<void> {
    await this.#gate.drain()
    await Promise.allSettled([...this.#active.values()].map(active => active.settled))
    await this.#gate.drain()
  }

  /** Persist one result and release its attempt lease. */
  complete(lease: DeliveryAttemptLease, outcome: MessageDeliveryOutcome): Promise<'delivered' | 'rejected' | 'retryable' | 'abandoned'> {
    return this.#gate.run(async () => {
      const active = this.#active.get(lease.messageId)
      if (active?.lease !== lease) {
        throw new CommunicationError('MESSAGE_TRANSPORT_SOURCE_INVALID', 'delivery attempt lease is no longer active', {
          details: { messageId: lease.messageId, attempt: lease.attempt },
        })
      }
      try {
        const verifiedOutcome = normalizeOutcome(lease, outcome)
        switch (verifiedOutcome.kind) {
          case 'accepted':
            await this.#appendStatus(outboxDeliveredEvent, {
              messageId: lease.messageId,
              attempt: lease.attempt,
              inboxEventId: verifiedOutcome.receipt.inboxEventId,
            })
            return 'delivered'
          case 'rejected':
            await this.#appendStatus(outboxRejectedEvent, {
              messageId: lease.messageId,
              attempt: lease.attempt,
              code: verifiedOutcome.code,
            })
            return 'rejected'
          case 'retry':
            await this.#appendStatus(outboxAttemptFailedEvent, {
              messageId: lease.messageId,
              attempt: lease.attempt,
              code: verifiedOutcome.code,
            })
            if (lease.attempt >= this.#options.maxDeliveryAttempts) {
              await this.#appendStatus(outboxAbandonedEvent, {
                messageId: lease.messageId,
                reason: 'attempts-exhausted',
              })
              return 'abandoned'
            }
            return 'retryable'
          default:
            return assertNever(verifiedOutcome, 'delivery outcome')
        }
      } finally {
        this.#active.delete(lease.messageId)
        active.settle()
      }
    })
  }

  /** Verify the exact Envelope and persisted open attempt presented to Transport. */
  verify(envelope: MessageEnvelope): boolean {
    const active = this.#active.get(envelope.messageId)
    if (active === undefined || !equalMessageEnvelopes(active.lease.envelope, envelope)) return false
    try {
      const snapshot = projectMailbox(this.#options.handle.snapshot(), this.#options.catalog)
      const message = snapshot.outbox.find(item => item.messageId === envelope.messageId)
      return message?.status === 'pending'
        && message.openAttempt === active.lease.attempt
        && this.#isChannelHead(message, snapshot.outbox)
    } catch {
      return false
    }
  }

  #isChannelHead(message: OutboxMessageSnapshot, outbox: readonly OutboxMessageSnapshot[]): boolean {
    const key = channelKey(message.envelope)
    return !outbox.some(candidate => candidate.status === 'pending'
      && channelKey(candidate.envelope) === key
      && candidate.envelope.channelSequence < message.envelope.channelSequence)
  }

  async #appendStatus(definition: Parameters<SessionHandle['append']>[0], payload: Parameters<SessionHandle['append']>[1]): Promise<void> {
    try {
      await this.#options.handle.append(definition, payload)
    } catch (cause) {
      if (cause instanceof SessionError && cause.code === 'SESSION_APPEND_OUTCOME_UNKNOWN') {
        this.#options.fault()
        throw new CommunicationError('MESSAGE_OUTBOX_STATUS_COMMIT_UNKNOWN', 'Outbox status commit outcome is unknown', {
          details: { type: definition.type }, cause,
        })
      }
      throw cause
    }
  }
}

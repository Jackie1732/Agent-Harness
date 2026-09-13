import { parseSessionAddress, parseSessionEventId } from '../session/index.js'
import type { CommittedSessionEvent, SessionSnapshot } from '../session/index.js'
import type { JsonValue } from '../foundation/json.js'
import { messageEnvelopeDigest } from './canonical-json.js'
import { CommunicationError } from './errors.js'
import { decodeMessagePayload } from './message-catalog.js'
import type { MessageCatalog } from './message-catalog.js'
import {
  inboxAbandonedEvent,
  inboxAcceptedEvent,
  inboxProcessedEvent,
  outboxAbandonedEvent,
  outboxAcceptedEvent,
  outboxAttemptFailedEvent,
  outboxAttemptStartedEvent,
  outboxDeliveredEvent,
  outboxRejectedEvent,
} from './session-events.js'
import type {
  InboxAbandonedPayload,
  InboxAcceptedPayload,
  InboxProcessedPayload,
  OutboxAbandonedPayload,
  OutboxAcceptedPayload,
  OutboxAttemptFailedPayload,
  OutboxAttemptStartedPayload,
  OutboxDeliveredPayload,
  OutboxRejectedPayload,
} from './session-events.js'
import type {
  InboxMessageSnapshot,
  MailboxSnapshot,
  MessageDeliveryReceipt,
  OutboxFailureSnapshot,
  OutboxMessageSnapshot,
} from './types.js'

interface MutableOutbox {
  readonly accepted: CommittedSessionEvent<OutboxAcceptedPayload>
  attemptCount: number
  openAttempt?: number
  lastFailure?: OutboxFailureSnapshot
  terminal?: OutboxMessageSnapshot
}

interface MutableInbox {
  readonly accepted: CommittedSessionEvent<InboxAcceptedPayload>
  readonly supported: boolean
  terminal?: InboxMessageSnapshot
}

function invalid(message: string, details: Record<string, JsonValue> = {}): never {
  throw new CommunicationError('MESSAGE_STATE_INVALID', message, { details })
}

function matches(event: CommittedSessionEvent, type: string, payloadVersion: number): boolean {
  return event.stored.type === type && event.stored.payloadVersion === payloadVersion
}

function channelKey(recipient: string, channelId: string): string {
  return `${recipient}\u0000${channelId}`
}

function requireOutbox(map: Map<string, MutableOutbox>, messageId: string): MutableOutbox {
  const state = map.get(messageId)
  if (state === undefined) invalid('outbox transition references an unknown message', { messageId })
  return state
}

function requireInbox(map: Map<string, MutableInbox>, messageId: string): MutableInbox {
  const state = map.get(messageId)
  if (state === undefined) invalid('inbox transition references an unknown message', { messageId })
  return state
}

function requireOpenAttempt(state: MutableOutbox, messageId: string, attempt: number): void {
  if (state.terminal !== undefined || state.openAttempt !== attempt) {
    invalid('outbox result does not settle its open attempt', { messageId, attempt })
  }
}

function pendingOutbox(state: MutableOutbox): OutboxMessageSnapshot {
  const envelope = state.accepted.payload.envelope
  return Object.freeze({
    messageId: envelope.messageId,
    envelope,
    acceptedEventId: state.accepted.stored.eventId,
    acceptedSequence: state.accepted.stored.sequence,
    attemptCount: state.attemptCount,
    ...(state.openAttempt === undefined ? {} : { openAttempt: state.openAttempt }),
    ...(state.lastFailure === undefined ? {} : { lastFailure: state.lastFailure }),
    status: 'pending' as const,
  })
}

function outboxTerminalBase(state: MutableOutbox): Omit<OutboxMessageSnapshot, 'status'> {
  const envelope = state.accepted.payload.envelope
  return {
    messageId: envelope.messageId,
    envelope,
    acceptedEventId: state.accepted.stored.eventId,
    acceptedSequence: state.accepted.stored.sequence,
    attemptCount: state.attemptCount,
    ...(state.lastFailure === undefined ? {} : { lastFailure: state.lastFailure }),
  }
}

function inboxBase(state: MutableInbox) {
  const envelope = state.accepted.payload.envelope
  return {
    messageId: envelope.messageId,
    envelope,
    digest: state.accepted.payload.digest,
    acceptedEventId: state.accepted.stored.eventId,
    acceptedSequence: state.accepted.stored.sequence,
    supported: state.supported,
  }
}

function applyOutboxEvent(
  event: CommittedSessionEvent,
  outbox: Map<string, MutableOutbox>,
  sequences: Map<string, number>,
  address: string,
): boolean {
  if (matches(event, outboxAcceptedEvent.type, outboxAcceptedEvent.payloadVersion)) {
    const accepted = event as CommittedSessionEvent<OutboxAcceptedPayload>
    const envelope = accepted.payload.envelope
    if (envelope.sender !== address) invalid('outbox envelope sender does not own the Session', { messageId: envelope.messageId })
    if (outbox.has(envelope.messageId)) invalid('outbox contains a duplicate message identity', { messageId: envelope.messageId })
    const key = channelKey(envelope.recipient, envelope.channelId)
    const expected = (sequences.get(key) ?? 0) + 1
    if (envelope.channelSequence !== expected) {
      invalid('outbox channel sequence is not contiguous', { messageId: envelope.messageId, expected, actual: envelope.channelSequence })
    }
    sequences.set(key, expected)
    outbox.set(envelope.messageId, { accepted, attemptCount: 0 })
    return true
  }
  if (matches(event, outboxAttemptStartedEvent.type, outboxAttemptStartedEvent.payloadVersion)) {
    const payload = (event as CommittedSessionEvent<OutboxAttemptStartedPayload>).payload
    const state = requireOutbox(outbox, payload.messageId)
    if (state.terminal !== undefined || state.openAttempt !== undefined || payload.attempt !== state.attemptCount + 1) {
      invalid('outbox attempt sequence is invalid', { messageId: payload.messageId, attempt: payload.attempt })
    }
    state.attemptCount = payload.attempt
    state.openAttempt = payload.attempt
    return true
  }
  if (matches(event, outboxAttemptFailedEvent.type, outboxAttemptFailedEvent.payloadVersion)) {
    const payload = (event as CommittedSessionEvent<OutboxAttemptFailedPayload>).payload
    const state = requireOutbox(outbox, payload.messageId)
    requireOpenAttempt(state, payload.messageId, payload.attempt)
    delete state.openAttempt
    state.lastFailure = Object.freeze({ attempt: payload.attempt, code: payload.code, eventId: event.stored.eventId })
    return true
  }
  if (matches(event, outboxDeliveredEvent.type, outboxDeliveredEvent.payloadVersion)) {
    const payload = (event as CommittedSessionEvent<OutboxDeliveredPayload>).payload
    const state = requireOutbox(outbox, payload.messageId)
    requireOpenAttempt(state, payload.messageId, payload.attempt)
    const envelope = state.accepted.payload.envelope
    const receiptOwner = parseSessionEventId(payload.inboxEventId).sessionId
    const recipientId = parseSessionAddress(envelope.recipient)
    if (receiptOwner !== recipientId) invalid('delivery receipt belongs to another Session', { messageId: payload.messageId })
    const receipt: MessageDeliveryReceipt = Object.freeze({
      messageId: payload.messageId,
      recipient: envelope.recipient,
      inboxEventId: payload.inboxEventId,
    })
    delete state.openAttempt
    state.terminal = Object.freeze({
      ...outboxTerminalBase(state), status: 'delivered', receipt, terminalEventId: event.stored.eventId,
    })
    return true
  }
  if (matches(event, outboxRejectedEvent.type, outboxRejectedEvent.payloadVersion)) {
    const payload = (event as CommittedSessionEvent<OutboxRejectedPayload>).payload
    const state = requireOutbox(outbox, payload.messageId)
    requireOpenAttempt(state, payload.messageId, payload.attempt)
    delete state.openAttempt
    state.terminal = Object.freeze({
      ...outboxTerminalBase(state), status: 'rejected', rejection: payload.code, terminalEventId: event.stored.eventId,
    })
    return true
  }
  if (matches(event, outboxAbandonedEvent.type, outboxAbandonedEvent.payloadVersion)) {
    const payload = (event as CommittedSessionEvent<OutboxAbandonedPayload>).payload
    const state = requireOutbox(outbox, payload.messageId)
    if (state.terminal !== undefined) invalid('outbox message has conflicting terminal states', { messageId: payload.messageId })
    if (state.openAttempt !== undefined) {
      invalid('outbox abandonment does not settle its open attempt', { messageId: payload.messageId, attempt: state.openAttempt })
    }
    state.terminal = Object.freeze({
      ...outboxTerminalBase(state), status: 'abandoned', abandonReason: payload.reason, terminalEventId: event.stored.eventId,
    })
    return true
  }
  return false
}

function applyInboxEvent(
  event: CommittedSessionEvent,
  inbox: Map<string, MutableInbox>,
  catalog: MessageCatalog,
  address: string,
): boolean {
  if (matches(event, inboxAcceptedEvent.type, inboxAcceptedEvent.payloadVersion)) {
    const accepted = event as CommittedSessionEvent<InboxAcceptedPayload>
    const envelope = accepted.payload.envelope
    if (envelope.recipient !== address) invalid('inbox envelope recipient does not own the Session', { messageId: envelope.messageId })
    if (inbox.has(envelope.messageId)) invalid('inbox contains a duplicate message identity', { messageId: envelope.messageId })
    if (messageEnvelopeDigest(envelope) !== accepted.payload.digest) invalid('inbox envelope digest does not match its content', { messageId: envelope.messageId })
    const definition = catalog.resolve(envelope.type, envelope.payloadVersion)
    if (definition !== undefined) {
      try {
        decodeMessagePayload(definition, envelope.payload)
      } catch {
        throw new CommunicationError('MESSAGE_STATE_INVALID', 'historical inbox payload fails its installed definition', {
          details: { messageId: envelope.messageId, type: envelope.type, payloadVersion: envelope.payloadVersion },
        })
      }
    }
    inbox.set(envelope.messageId, { accepted, supported: definition !== undefined })
    return true
  }
  if (matches(event, inboxProcessedEvent.type, inboxProcessedEvent.payloadVersion)) {
    const payload = (event as CommittedSessionEvent<InboxProcessedPayload>).payload
    const state = requireInbox(inbox, payload.messageId)
    if (!state.supported) invalid('unsupported inbox message cannot be processed', { messageId: payload.messageId })
    if (state.terminal !== undefined) invalid('inbox message has conflicting terminal states', { messageId: payload.messageId })
    state.terminal = Object.freeze({ ...inboxBase(state), status: 'processed', terminalEventId: event.stored.eventId })
    return true
  }
  if (matches(event, inboxAbandonedEvent.type, inboxAbandonedEvent.payloadVersion)) {
    const payload = (event as CommittedSessionEvent<InboxAbandonedPayload>).payload
    const state = requireInbox(inbox, payload.messageId)
    if (state.terminal !== undefined) invalid('inbox message has conflicting terminal states', { messageId: payload.messageId })
    state.terminal = Object.freeze({
      ...inboxBase(state), status: 'abandoned', abandonReason: payload.reason, terminalEventId: event.stored.eventId,
    })
    return true
  }
  return false
}

/** Reconstruct and validate one Session's locally owned communication state. */
export function projectMailbox(snapshot: SessionSnapshot, catalog: MessageCatalog): MailboxSnapshot {
  const outbox = new Map<string, MutableOutbox>()
  const inbox = new Map<string, MutableInbox>()
  const sequences = new Map<string, number>()
  const target = snapshot.history.find(segment => segment.header.sessionId === snapshot.header.sessionId)
  if (target === undefined) invalid('Session snapshot does not contain its target segment')
  for (const record of target.events) {
    if (record.kind === 'opaque') {
      if (record.stored.type.startsWith('communication/')) invalid('communication event cannot be opaque')
      continue
    }
    const handled = applyOutboxEvent(record, outbox, sequences, snapshot.address)
      || applyInboxEvent(record, inbox, catalog, snapshot.address)
    if (!handled && record.stored.type.startsWith('communication/')) {
      invalid('unsupported communication event version', { type: record.stored.type, payloadVersion: record.stored.payloadVersion })
    }
  }
  const outboxSnapshots = [...outbox.values()]
    .map(state => state.terminal ?? pendingOutbox(state))
    .sort((left, right) => left.acceptedSequence - right.acceptedSequence)
  const inboxSnapshots = [...inbox.values()]
    .map(state => state.terminal ?? Object.freeze({ ...inboxBase(state), status: 'pending' as const }))
    .sort((left, right) => left.acceptedSequence - right.acceptedSequence)
  return Object.freeze({
    sessionId: snapshot.header.sessionId,
    address: snapshot.address,
    outbox: Object.freeze(outboxSnapshots),
    inbox: Object.freeze(inboxSnapshots),
    unsupportedInbox: Object.freeze(inboxSnapshots.filter(item => !item.supported).map(item => item.messageId)),
  })
}

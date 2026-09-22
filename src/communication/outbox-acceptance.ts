import type { DelegationChannelLease } from './delegation-channels.js'
import { clockTimestamp } from '../foundation/clock.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import { SerialGate } from '../foundation/serial-gate.js'
import { SessionError } from '../session/errors.js'
import { parseSessionEventId } from '../session/ids.js'
import { evaluatePolicyDecision } from './configuration.js'
import { decodeMessageEnvelope } from './envelope.js'
import { CommunicationError } from './errors.js'
import { channelSequence, parseMessageId } from './ids.js'
import type { MessageId } from './ids.js'
import { keyedOutboxAcceptedEvent } from './keyed-event.js'
import type { MailboxJournalOptions } from './mailbox-journal.js'
import { decodeMessagePayload } from './message-catalog.js'
import type { MessageDefinition } from './message-catalog.js'
import { projectCommunicationFacts, projectMailbox } from './projection.js'
import { decodeSendCommand, decodeSendKey, decodeSendRequest, sendKeyText } from './send-command.js'
import type { MessageSendCommand, MessageSendKey } from './send-command.js'
import { outboxAcceptedEvent } from './session-events.js'
import type { MessageSendRequest, OutgoingMessageAccepted } from './types.js'

/** One acceptance owner for both legacy and keyed sends; retries only local CAS. */
export class OutboxAcceptance {
  readonly #gate = new SerialGate()
  constructor(readonly options: MailboxJournalOptions) {}

  send<T extends JsonValue>(definition: MessageDefinition<T>, request: MessageSendRequest, decoded: T): Promise<OutgoingMessageAccepted<T>> {
    let captured: MessageSendRequest
    try { captured = decodeSendRequest(request) }
    catch { return Promise.reject(new CommunicationError('MESSAGE_ENVELOPE_INVALID', 'message request is not canonical')) }
    return this.#gate.run(() => this.#commit(definition, captured, decoded)) as Promise<OutgoingMessageAccepted<T>>
  }
  reply<T extends JsonValue>(inboxId: MessageId, definition: MessageDefinition<T>, decoded: T): Promise<OutgoingMessageAccepted<T>> {
    return this.#gate.run(() => this.#commit(definition, this.#replyRequest(inboxId), decoded, inboxId)) as Promise<OutgoingMessageAccepted<T>>
  }
  sendOnce(keyInput: MessageSendKey, commandInput: MessageSendCommand, lease?: DelegationChannelLease): Promise<OutgoingMessageAccepted> {
    const key = decodeSendKey(keyInput)
    const command = decodeSendCommand(commandInput)
    return this.#gate.run(() => {
      this.#assertKey(key)
      const prior = this.#existing(key, command)
      if (prior !== null) return prior
      const definition = this.options.catalog.resolve(command.type, command.payloadVersion)
      if (definition === undefined) throw new CommunicationError('MESSAGE_DEFINITION_UNREGISTERED', 'new keyed send requires its message definition')
      const payload = decodeMessagePayload(definition, command.payload)
      const request = command.kind === 'send' ? command.request : this.#replyRequest(command.inboxMessageId)
      return this.#commit(definition, request, payload, command.kind === 'reply' ? command.inboxMessageId : undefined, { key, command }, lease)
    })
  }
  #assertKey(key: MessageSendKey): void {
    const reference = parseSessionEventId(key.eventId)
    const snapshot = this.options.handle.snapshot()
    if (reference.sessionId !== snapshot.header.sessionId || reference.sequence > snapshot.localPosition) {
      throw new CommunicationError('MESSAGE_SEND_KEY_CONFLICT', 'send key must reference an earlier local command')
    }
  }
  #existing(key: MessageSendKey, command: MessageSendCommand): OutgoingMessageAccepted | null {
    const prior = projectCommunicationFacts(this.options.handle.snapshot()).outbox.find(item => item.sendKey !== undefined && sendKeyText(item.sendKey) === sendKeyText(key))
    if (prior === undefined) return null
    if (prior.command === undefined || !Buffer.from(canonicalJsonBytes(prior.command)).equals(Buffer.from(canonicalJsonBytes(command)))) {
      throw new CommunicationError('MESSAGE_SEND_KEY_CONFLICT', 'send key already identifies a different raw command')
    }
    return Object.freeze({ messageId: prior.messageId, envelope: prior.envelope, outboxEventId: prior.acceptedEventId })
  }
  #replyRequest(inboxId: MessageId): MessageSendRequest {
    const incoming = projectMailbox(this.options.handle.snapshot(), this.options.catalog).inbox.find(item => item.messageId === inboxId)
    if (incoming === undefined) throw new CommunicationError('MESSAGE_NOT_FOUND', 'Inbox message does not exist')
    if (!incoming.supported) throw new CommunicationError('MESSAGE_STATE_INVALID', 'unsupported Inbox message cannot be replied to')
    return { kind: 'derived', recipient: incoming.envelope.sender, channelId: incoming.envelope.channelId,
      correlationId: incoming.envelope.correlationId, causationId: incoming.messageId }
  }
  async #commit(
    definition: MessageDefinition, request: MessageSendRequest, payload: JsonValue, replyTo?: MessageId,
    keyed?: { readonly key: MessageSendKey; readonly command: MessageSendCommand }, lease?: DelegationChannelLease,
  ): Promise<OutgoingMessageAccepted> {
    return this.options.channels === undefined ? this.#accept(definition, request, payload, replyTo, keyed, lease)
      : this.options.channels.run(() => this.#accept(definition, request, payload, replyTo, keyed, lease))
  }
  async #accept(definition: MessageDefinition, request: MessageSendRequest, payload: JsonValue, replyTo?: MessageId,
    keyed?: { readonly key: MessageSendKey; readonly command: MessageSendCommand }, lease?: DelegationChannelLease): Promise<OutgoingMessageAccepted> {
    const { handle, limits, policy } = this.options
    const decision = evaluatePolicyDecision(() => policy.canSend({ sender: handle.header.address, recipient: request.recipient,
      channelId: request.channelId, type: definition.type, payloadVersion: definition.payloadVersion }))
    const protocol = definition.type.startsWith('subagent/')
    if (protocol) {
      if (lease === undefined || keyed === undefined || this.options.channels === undefined) throw new CommunicationError('MESSAGE_SEND_FORBIDDEN', 'reserved protocol requires a channel lease')
      this.options.channels.assertSend(lease, handle, keyed.key, keyed.command)
    }
    if (!protocol && decision.kind === 'deny') throw new CommunicationError('MESSAGE_SEND_FORBIDDEN', 'outgoing communication policy denied the message', { details: { reasonCode: decision.reasonCode } })
    const messageId = parseMessageId(this.options.identitySource.nextMessageId())
    const createdAt = clockTimestamp(this.options.clock)
    for (let attempt = 0; attempt <= limits.maxSendJournalConflicts; attempt++) {
      if (keyed !== undefined) {
        const prior = this.#existing(keyed.key, keyed.command)
        if (prior !== null) return prior
      }
      const snapshot = handle.snapshot()
      if (snapshot.lifecycle === 'ended') throw new CommunicationError('MESSAGE_SESSION_ENDED', 'Session is already ended')
      const facts = projectCommunicationFacts(snapshot)
      if ([...facts.outbox, ...facts.inbox].some(item => item.messageId === messageId)) throw new CommunicationError('MESSAGE_ID_CONFLICT', 'generated Message identity already exists locally')
      const previous = facts.outbox.filter(item => item.envelope.recipient === request.recipient && item.envelope.channelId === request.channelId)
        .reduce((maximum, item) => Math.max(maximum, item.envelope.channelSequence), 0)
      if (previous >= Number.MAX_SAFE_INTEGER) throw new CommunicationError('MESSAGE_SEQUENCE_EXHAUSTED', 'Channel sequence is exhausted')
      const envelope = decodeMessageEnvelope({ envelopeVersion: 1, messageId, sender: handle.header.address, recipient: request.recipient,
        channelId: request.channelId, channelSequence: channelSequence(previous + 1), correlationId: request.kind === 'root' ? messageId : request.correlationId,
        ...(request.kind === 'derived' ? { causationId: request.causationId } : {}), ...(replyTo === undefined ? {} : { replyTo }),
        createdAt, type: definition.type, payloadVersion: definition.payloadVersion, payload })
      if (this.options.channels !== undefined ? !this.options.channels.hasCapacity(handle, 'outbox', envelope)
        : facts.outbox.filter(item => item.status === 'pending').length >= limits.maxPendingOutbox) throw new CommunicationError('MESSAGE_OUTBOX_FULL', 'Outbox pending limit is reached')
      if (canonicalJsonBytes(envelope).byteLength > limits.maxMessageBytes) throw new CommunicationError('MESSAGE_ENVELOPE_INVALID', 'Message Envelope exceeds maxMessageBytes')
      if (keyed !== undefined && canonicalJsonBytes(keyed.command).byteLength > limits.maxMessageBytes) throw new CommunicationError('MESSAGE_ENVELOPE_INVALID', 'raw command exceeds maxMessageBytes')
      try {
        const event = keyed === undefined
          ? await handle.appendIfPosition(snapshot.localPosition, outboxAcceptedEvent, { envelope })
          : await handle.appendIfPosition(snapshot.localPosition, keyedOutboxAcceptedEvent, { envelope, sendKey: keyed.key, command: keyed.command })
        return Object.freeze({ messageId, envelope, outboxEventId: event.stored.eventId })
      } catch (error) {
        if (error instanceof SessionError && error.code === 'SESSION_PRECONDITION_FAILED') continue
        if (error instanceof SessionError && error.code === 'SESSION_APPEND_OUTCOME_UNKNOWN') {
          this.options.fault()
          throw new CommunicationError('MESSAGE_OUTBOX_COMMIT_UNKNOWN', 'Outbox commit outcome is unknown', { details: { messageId } })
        }
        throw error
      }
    }
    throw new CommunicationError('MESSAGE_SEND_JOURNAL_CONFLICT', 'send acceptance conflict limit reached')
  }
}

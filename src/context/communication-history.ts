import type { JsonValue } from '../foundation/json.js'
import type { SessionSnapshot } from '../session/types.js'
import type { ContextPendingOutbox } from './contract.js'
import { invalidSource } from './errors.js'
import type { CommunicationFacts, InboxMessageFact, OutboxMessageSnapshot } from '../communication/types.js'
import { parseSessionEventId } from '../session/ids.js'
import type { ContextPeerMetadata } from './contract.js'
import { dataNote } from './render.js'
import type { ContextUnit } from './unit.js'

export function peerMetadata(message: InboxMessageFact | OutboxMessageSnapshot, kind: 'peer-message' | 'outbox-message'): ContextPeerMetadata {
  const e = message.envelope
  return { kind, messageId: e.messageId, sender: e.sender, recipient: e.recipient, channelId: e.channelId,
    channelSequence: e.channelSequence, correlationId: e.correlationId, causationId: e.causationId ?? null,
    replyTo: e.replyTo ?? null, type: e.type, payloadVersion: e.payloadVersion, createdAt: e.createdAt,
    status: message.status, terminalEventId: 'terminalEventId' in message ? message.terminalEventId : null }
}
export function communicationHistoryUnits(facts: CommunicationFacts, ordinal: number): readonly ContextUnit[] {
  return [
    ...facts.inbox.map(message => make(message, 'peer-message', ordinal)),
    ...facts.outbox.map(message => make(message, 'outbox-message', ordinal)),
  ]
}
function make(message: InboxMessageFact | OutboxMessageSnapshot, selector: 'peer-message' | 'outbox-message', ordinal: number): ContextUnit {
  const reference = { eventId: message.acceptedEventId, selector }
  const metadata = peerMetadata(message, selector)
  const sourceEventIds = [message.acceptedEventId, ...(metadata.terminalEventId === null ? [] : [metadata.terminalEventId])]
  return { reference, sourceEventIds, segmentOrdinal: ordinal,
    closureSequence: metadata.terminalEventId === null ? message.acceptedSequence : parseSessionEventId(metadata.terminalEventId).sequence,
    metadata, body: message.envelope.payload, canonicalSource: { metadata, envelope: message.envelope },
    rawMessages: [dataNote(selector, reference, metadata, message.envelope.payload)],
    optionalHistory: selector === 'peer-message' && message.status !== 'pending',
    compactable: selector === 'peer-message' && message.status !== 'pending' }
}

/** Retain earlier unknown attempts even when the newest attempt has another result. */
export function pendingOutboxContext(facts: CommunicationFacts, snapshot: SessionSnapshot): readonly ContextPendingOutbox[] {
  const previouslyUnknown = new Set<string>()
  const localHistory = snapshot.history.at(-1)
  if (localHistory === undefined) invalidSource('empty-history')
  for (const event of localHistory.events) {
    if (event.kind !== 'known' || event.stored.type !== 'communication/outbox-attempt-failed' || event.stored.payloadVersion !== 1) continue
    const payload = event.payload
    if (payload !== null && !Array.isArray(payload) && typeof payload === 'object') {
      const object = payload as Readonly<Record<string, JsonValue>>
      if ((object.code === 'transport-outcome-unknown' || object.code === 'receiver-outcome-unknown')
        && typeof object.messageId === 'string') previouslyUnknown.add(object.messageId)
    }
  }
  const pendingOutbox: ContextPendingOutbox[] = facts.outbox.filter(item => item.status === 'pending').map(item => {
    const e = item.envelope
    return { messageId: item.messageId, acceptedEventId: item.acceptedEventId, recipient: e.recipient, channelId: e.channelId,
      channelSequence: e.channelSequence, correlationId: e.correlationId, causationId: e.causationId ?? null, replyTo: e.replyTo ?? null,
      attemptCount: item.attemptCount, openAttempt: item.openAttempt ?? null, lastFailure: item.lastFailure?.code ?? null,
      outcomeUnknown: item.openAttempt !== undefined || previouslyUnknown.has(item.messageId) }
  })
  return pendingOutbox
}

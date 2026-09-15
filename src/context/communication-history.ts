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

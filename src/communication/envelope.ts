import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { isCanonicalIsoTimestamp } from '../foundation/protocol-scalars.js'
import { parseSessionAddress } from '../session/index.js'
import type { SessionAddress } from '../session/index.js'
import { invalidEnvelope, requireExactKeys, requireNumber, requireRecord, requireString } from './codec-fields.js'
import { channelSequence, parseChannelId, parseMessageId } from './ids.js'
import { validateMessagePayloadVersion, validateMessageType } from './message-catalog.js'
import { MESSAGE_ENVELOPE_VERSION } from './types.js'
import type { MessageEnvelope } from './types.js'

function sessionAddress(value: JsonValue | undefined, label: string): SessionAddress {
  const text = requireString(value, label)
  try {
    parseSessionAddress(text)
  } catch (cause) {
    throw invalidEnvelope(`${label} is not canonical`, cause)
  }
  return text as SessionAddress
}

/** Strictly validate, copy, and freeze one Message Envelope value. */
export function decodeMessageEnvelope(value: JsonValue): MessageEnvelope {
  const record = requireRecord(snapshotJson(value, 'message envelope'), 'message envelope')
  requireExactKeys(
    record,
    [
      'envelopeVersion',
      'messageId',
      'sender',
      'recipient',
      'channelId',
      'channelSequence',
      'correlationId',
      'createdAt',
      'type',
      'payloadVersion',
      'payload',
    ],
    ['causationId', 'replyTo'],
    'message envelope',
  )
  if (record.envelopeVersion !== MESSAGE_ENVELOPE_VERSION) {
    throw invalidEnvelope('message envelopeVersion is unsupported')
  }
  const messageId = parseMessageId(requireString(record.messageId, 'message messageId'))
  const correlationId = parseMessageId(requireString(record.correlationId, 'message correlationId'))
  const causationId = record.causationId === undefined
    ? undefined
    : parseMessageId(requireString(record.causationId, 'message causationId'))
  const replyTo = record.replyTo === undefined
    ? undefined
    : parseMessageId(requireString(record.replyTo, 'message replyTo'))
  if (causationId === undefined && correlationId !== messageId) {
    throw invalidEnvelope('root message correlationId must equal messageId')
  }
  if (replyTo !== undefined && (causationId === undefined || causationId !== replyTo)) {
    throw invalidEnvelope('replyTo requires an equal causationId')
  }
  const createdAt = requireString(record.createdAt, 'message createdAt')
  if (!isCanonicalIsoTimestamp(createdAt)) {
    throw invalidEnvelope('message createdAt must be a canonical ISO timestamp')
  }
  const envelope: JsonObject = {
    envelopeVersion: MESSAGE_ENVELOPE_VERSION,
    messageId,
    sender: sessionAddress(record.sender, 'message sender'),
    recipient: sessionAddress(record.recipient, 'message recipient'),
    channelId: parseChannelId(requireString(record.channelId, 'message channelId')),
    channelSequence: channelSequence(requireNumber(record.channelSequence, 'message channelSequence')),
    correlationId,
    ...(causationId === undefined ? {} : { causationId }),
    ...(replyTo === undefined ? {} : { replyTo }),
    createdAt,
    type: validateMessageType(requireString(record.type, 'message type')),
    payloadVersion: validateMessagePayloadVersion(requireNumber(record.payloadVersion, 'message payloadVersion')),
    payload: snapshotJson(record.payload, 'message payload'),
  }
  return Object.freeze(envelope) as MessageEnvelope
}

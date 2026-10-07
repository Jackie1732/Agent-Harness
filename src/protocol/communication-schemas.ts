import { addressSchema as address, choice, eventIdSchema as event, integerSchema as integer,
  literal, nameSchema as name, object, positiveSchema as positive, stringSchema as string, timestampSchema as time,
  union, uuidSchema as uuid } from './schema-fields.js'

const envelope = object({ envelopeVersion: literal(1), messageId: uuid, sender: address, recipient: address, channelId: uuid,
  channelSequence: positive, correlationId: uuid, causationId: uuid, replyTo: uuid, createdAt: time,
  type: name, payloadVersion: positive, payload: {} }, ['causationId', 'replyTo'])
const request = union(object({ kind: literal('root'), recipient: address, channelId: uuid }),
  object({ kind: literal('derived'), recipient: address, channelId: uuid, correlationId: uuid, causationId: uuid }))
const command = union(object({ kind: literal('send'), type: name, payloadVersion: positive, payload: {}, request }),
  object({ kind: literal('reply'), type: name, payloadVersion: positive, payload: {}, inboxMessageId: uuid }))
const retryCodes = ['recipient-offline', 'recipient-ending', 'recipient-backpressure', 'attempt-interrupted', 'receiver-outcome-unknown', 'transport-outcome-unknown']
const rejectionCodes = ['recipient-unknown', 'recipient-ended', 'receive-forbidden', 'message-unsupported', 'payload-invalid', 'message-id-conflict']
const outboxBase = { messageId: uuid, envelope, acceptedEventId: event, acceptedSequence: positive, attemptCount: integer,
  sendKey: object({ eventId: event, index: integer }), command, openAttempt: positive,
  lastFailure: object({ attempt: positive, code: choice(retryCodes), eventId: event }) }
const outboxOptional = ['sendKey', 'command', 'openAttempt', 'lastFailure']
const inboxBase = { messageId: uuid, envelope, digest: { ...string, pattern: '^[a-f0-9]{64}$' }, acceptedEventId: event, acceptedSequence: positive }

export const outboxFactSchema = union(object({ ...outboxBase, status: literal('pending') }, outboxOptional),
  object({ ...outboxBase, status: literal('delivered'), receipt: object({ messageId: uuid, recipient: address, inboxEventId: event }), terminalEventId: event }, outboxOptional),
  object({ ...outboxBase, status: literal('rejected'), rejection: choice(rejectionCodes), terminalEventId: event }, outboxOptional),
  object({ ...outboxBase, status: literal('abandoned'), abandonReason: choice(['caller-requested', 'attempts-exhausted']), terminalEventId: event }, outboxOptional))
export const inboxFactSchema = union(object({ ...inboxBase, status: literal('pending') }),
  object({ ...inboxBase, status: literal('processed'), terminalEventId: event }),
  object({ ...inboxBase, status: literal('abandoned'), abandonReason: choice(['caller-requested', 'unsupported-message']), terminalEventId: event }))

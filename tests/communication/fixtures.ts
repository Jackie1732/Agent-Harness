import {
  CommunicationService,
  MemorySessionBackend,
  SessionRepository,
  allowAllCommunicationPolicy,
  communicationSessionEventDefinitions,
  createDurableEventCatalog,
  createInProcessMessageTransport,
  createMessageCatalog,
  createMessageDefinition,
  createSessionDirectory,
  parseChannelId,
  parseMessageId,
  parseSessionId,
} from '../../src/index.js'
import type {
  CommunicationIdentitySource,
  JsonObject,
  JsonValue,
  MailboxLimits,
  MessageCatalog,
  SessionBackend,
  SessionIdentitySource,
} from '../../src/index.js'

export interface TextPayload extends JsonObject {
  readonly text: string
}

function textPayload(value: JsonValue): TextPayload {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new TypeError('payload must be an object')
  const record = value as JsonObject
  if (Object.keys(record).length !== 1 || typeof record.text !== 'string') throw new TypeError('payload.text is required')
  return { text: record.text }
}

export const requestMessage = createMessageDefinition<TextPayload>({
  type: 'test/request',
  payloadVersion: 1,
  decode: textPayload,
})

export const replyMessage = createMessageDefinition<TextPayload>({
  type: 'test/reply',
  payloadVersion: 1,
  decode: textPayload,
})

export const messageCatalog: MessageCatalog = createMessageCatalog([requestMessage, replyMessage])

export const sessionIds = [
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
  '00000000-0000-4000-8000-000000000104',
] as const

export const messageIds = [
  '10000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000102',
  '10000000-0000-4000-8000-000000000103',
  '10000000-0000-4000-8000-000000000104',
  '10000000-0000-4000-8000-000000000105',
] as const

export const channelIds = [
  '20000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000102',
] as const

export function sessionIdentities(values: readonly string[] = sessionIds): SessionIdentitySource {
  let index = 0
  return {
    nextSessionId: () => {
      const value = values[index++]
      if (value === undefined) throw new Error('Session identity fixture exhausted')
      return parseSessionId(value)
    },
  }
}

export function communicationIdentities(values: readonly string[] = messageIds): CommunicationIdentitySource {
  let messageIndex = 0
  let channelIndex = 0
  return {
    nextMessageId: () => {
      const value = values[messageIndex++]
      if (value === undefined) throw new Error('Message identity fixture exhausted')
      return parseMessageId(value)
    },
    nextChannelId: () => {
      const value = channelIds[channelIndex++]
      if (value === undefined) throw new Error('Channel identity fixture exhausted')
      return parseChannelId(value)
    },
  }
}

export const limits: MailboxLimits = Object.freeze({
  maxMessageBytes: 4096,
  maxPendingOutbox: 8,
  maxPendingInbox: 8,
  maxDeliveryAttempts: 3,
  maxAttemptsPerRun: 8,
})

export function createRepository(
  backend: SessionBackend = new MemorySessionBackend({ maxRecordBytes: 8192 }),
  identities: SessionIdentitySource = sessionIdentities(),
): SessionRepository {
  return new SessionRepository({
    backend,
    catalog: createDurableEventCatalog(communicationSessionEventDefinitions),
    maxLineageDepth: 4,
    identitySource: identities,
    clock: { now: () => 1_789_257_600_000 },
  })
}

export function createCommunicationService(overrides: Partial<MailboxLimits> = {}) {
  const directory = createSessionDirectory()
  const transport = createInProcessMessageTransport(directory)
  const service = new CommunicationService({
    directory,
    transport,
    limits: { ...limits, ...overrides },
    identitySource: communicationIdentities(),
    clock: { now: () => 1_789_257_600_000 },
  })
  return { directory, transport, service, policy: allowAllCommunicationPolicy }
}

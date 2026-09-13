import {
  CommunicationService,
  allowAllCommunicationPolicy,
  createChannelId,
  createInProcessMessageTransport,
  createMessageCatalog,
  createSessionDirectory,
  parseChannelId,
  parseMessageId,
} from '../../src/index.js'
import type {
  ChannelId,
  CommunicationPolicy,
  MailboxLimits,
  MessageCatalog,
  MessageId,
  SessionAddress,
  SessionHandle,
  SessionMailbox,
} from '../../src/index.js'

const directory = createSessionDirectory()
const transport = createInProcessMessageTransport(directory)
const limits: MailboxLimits = {
  maxMessageBytes: 1024,
  maxPendingOutbox: 1,
  maxPendingInbox: 1,
  maxDeliveryAttempts: 1,
  maxAttemptsPerRun: 1,
}
const service = new CommunicationService({ directory, transport, limits })
const catalog: MessageCatalog = createMessageCatalog()
const policy: CommunicationPolicy = allowAllCommunicationPolicy

declare const handle: SessionHandle
declare const mailbox: SessionMailbox
declare const address: SessionAddress
void service.attach(handle, { catalog, policy })
void service.createDispatcher(mailbox).dispatch()
void createChannelId()
void parseChannelId('20000000-0000-4000-8000-000000000001')
void parseMessageId('10000000-0000-4000-8000-000000000001')

declare const messageId: MessageId
declare const channelId: ChannelId
// @ts-expect-error Message and Channel identities cannot cross protocol roles.
const invalidChannel: ChannelId = messageId
// @ts-expect-error Session addresses cannot be used as Message identities.
const invalidMessage: MessageId = address
void channelId
void invalidChannel
void invalidMessage

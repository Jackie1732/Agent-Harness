export {
  CommunicationServiceKey,
  MessageTransportKey,
  SessionDirectoryKey,
  createCommunicationServiceComponent,
  createInProcessMessageTransportComponent,
  createSessionDirectoryComponent,
} from './component.js'
export { messageEnvelopeDigest, canonicalJsonBytes, equalMessageEnvelopes } from './canonical-json.js'
export { createSessionDirectory } from './directory.js'
export { CommunicationError } from './errors.js'
export { decodeMessageEnvelope } from './envelope.js'
export { channelSequence, createChannelId, parseChannelId, parseMessageId, systemCommunicationIdentitySource } from './ids.js'
export { createMessageCatalog, createMessageDefinition, decodeMessagePayload } from './message-catalog.js'
export { projectCommunicationFacts, projectMailbox } from './projection.js'
export { CommunicationService } from './service.js'
export { communicationSessionEventDefinitions } from './session-events.js'
export { keyedOutboxAcceptedEvent } from './keyed-event.js'
export type { KeyedOutboxAcceptedPayload } from './keyed-event.js'
export type { MessageSendKey, MessageSendCommand, MessageCommandContent } from './send-command.js'
export { createInProcessMessageTransport } from './transport.js'
export { createRoutedMessageTransport } from './routed-transport.js'
export { createHttpsMessageClientTransport, createHttpsMessageServer } from './https-transport.js'

export type { CommunicationServiceComponentOptions } from './component.js'
export type { SessionDirectory, SessionDirectoryDeclaration, DirectoryStatus } from './directory.js'
export type { OutboxDispatcher, OutboxDispatchOptions } from './dispatcher.js'
export type { CommunicationErrorCode } from './errors.js'
export type { ChannelId, ChannelSequence, CommunicationIdentitySource, MessageId } from './ids.js'
export type { SessionMailbox } from './mailbox.js'
export type { MessageCatalog, MessageDefinition, MessageDefinitionOptions } from './message-catalog.js'
export type { CommunicationServiceOptions, MailboxAttachmentOptions } from './service.js'
export type { MessageTransport } from './transport.js'
export type { MessageRoute, MessageRouteResolver } from './routed-transport.js'
export type {
  HttpsMessageClientOptions, HttpsMessageLimits, HttpsMessageServer, HttpsMessageServerOptions, HttpsPeerAuthorization,
} from './https-transport.js'
export type {
  CommunicationPolicy,
  CommunicationFacts,
  InboxAbandonReason,
  InboxMessageSnapshot,
  InboxMessageFact,
  IncomingMessagePolicyInput,
  MailboxLimits,
  MailboxSnapshot,
  MessageDeliveryOutcome,
  MessageDeliveryReceipt,
  MessageEnvelope,
  MessagePolicyDecision,
  MessageRejectionCode,
  MessageRetryCode,
  MessageSendRequest,
  OutboxAbandonReason,
  OutboxDispatchReport,
  OutboxFailureSnapshot,
  OutboxMessageSnapshot,
  OutgoingMessageAccepted,
  OutgoingMessagePolicyInput,
  SessionMailboxStatus,
} from './types.js'
export { allowAllCommunicationPolicy, MESSAGE_ENVELOPE_VERSION } from './types.js'

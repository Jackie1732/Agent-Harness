import { createCapabilityKey } from '../capability/index.js'
import type { ComponentContext, ComponentDefinition } from '../capability/index.js'
import type { Clock } from '../foundation/clock.js'
import { createSessionDirectory } from './directory.js'
import type { SessionDirectory } from './directory.js'
import type { CommunicationIdentitySource } from './ids.js'
import { CommunicationService } from './service.js'
import type { CommunicationServiceOptions } from './service.js'
import { createInProcessMessageTransport } from './transport.js'
import type { MessageTransport } from './transport.js'
import type { MailboxLimits } from './types.js'

/** Capability key for a process-local Session address directory. */
export const SessionDirectoryKey = createCapabilityKey<SessionDirectory>('core.communication.directory')

/** Capability key for one Message delivery provider. */
export const MessageTransportKey = createCapabilityKey<MessageTransport>('core.communication.transport')

/** Capability key for Session Mailbox attachment and Dispatcher creation. */
export const CommunicationServiceKey = createCapabilityKey<CommunicationService>('core.communication.service')

/** Fixed Communication Service configuration supplied by its Component. */
export interface CommunicationServiceComponentOptions {
  readonly limits: MailboxLimits
  readonly clock?: Clock
  readonly identitySource?: CommunicationIdentitySource
}

/** Create the Component that owns one isolated Session Directory. */
export function createSessionDirectoryComponent(): ComponentDefinition {
  return Object.freeze({
    label: 'Session Directory',
    requires: Object.freeze([]),
    provides: Object.freeze([SessionDirectoryKey]),
    setup: async (context: ComponentContext) => {
      const directory = await context.apply(
        'Session Directory',
        () => createSessionDirectory(),
        active => active.dispose(),
      )
      context.provide(SessionDirectoryKey, directory)
    },
  })
}

/** Create the Component that routes messages through the required Directory. */
export function createInProcessMessageTransportComponent(): ComponentDefinition {
  return Object.freeze({
    label: 'In-process Message Transport',
    requires: Object.freeze([SessionDirectoryKey]),
    provides: Object.freeze([MessageTransportKey]),
    setup: async (context: ComponentContext) => {
      const directory = context.require(SessionDirectoryKey)
      const transport = await context.apply(
        'In-process Message Transport',
        () => createInProcessMessageTransport(directory),
        active => active.dispose(),
      )
      context.provide(MessageTransportKey, transport)
    },
  })
}

/** Create the Component that owns Mailbox attachments over required routing capabilities. */
export function createCommunicationServiceComponent(
  options: CommunicationServiceComponentOptions,
): ComponentDefinition {
  return Object.freeze({
    label: 'Communication Service',
    requires: Object.freeze([SessionDirectoryKey, MessageTransportKey]),
    provides: Object.freeze([CommunicationServiceKey]),
    setup: async (context: ComponentContext) => {
      const serviceOptions: CommunicationServiceOptions = {
        directory: context.require(SessionDirectoryKey),
        transport: context.require(MessageTransportKey),
        limits: options.limits,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.identitySource === undefined ? {} : { identitySource: options.identitySource }),
      }
      const service = await context.apply(
        'Communication Service',
        () => new CommunicationService(serviceOptions),
        active => active.dispose(),
      )
      context.provide(CommunicationServiceKey, service)
    },
  })
}

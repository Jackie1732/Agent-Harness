import { DelegationChannels } from './delegation-channels.js'
import type { DelegationChannelLease } from './delegation-channels.js'
import type { MessageSendKey, MessageSendCommand } from './send-command.js'
import { systemClock } from '../foundation/clock.js'
import type { Clock } from '../foundation/clock.js'
import { SerialGate } from '../foundation/serial-gate.js'
import type { EffectLease } from '../effect/index.js'
import type { SessionHandle } from '../session/index.js'
import { validateCommunicationPolicy, validateMailboxLimits } from './configuration.js'
import type { SessionDirectory, SessionDirectoryDeclaration } from './directory.js'
import { markDirectoryAddressEnded, registerDirectoryReceiver } from './directory.js'
import { createOutboxDispatcher } from './dispatcher.js'
import type { OutboxDispatcher } from './dispatcher.js'
import { CommunicationError } from './errors.js'
import type { CommunicationIdentitySource } from './ids.js'
import { systemCommunicationIdentitySource } from './ids.js'
import { SessionMailboxImpl } from './mailbox.js'
import type { SessionMailbox } from './mailbox.js'
import type { MessageCatalog } from './message-catalog.js'
import { projectMailbox } from './projection.js'
import { communicationSessionEventDefinitions } from './session-events.js'
import type { MessageTransport } from './transport.js'
import type { CommunicationPolicy, MailboxLimits } from './types.js'

/** Required dependencies and fixed budgets of a Communication Service. */
export interface CommunicationServiceOptions {
  readonly directory: SessionDirectory
  readonly transport: MessageTransport
  readonly limits: MailboxLimits
  readonly clock?: Clock
  readonly identitySource?: CommunicationIdentitySource
}

/** Per-Session protocol and policy chosen for one Mailbox lifetime. */
export interface MailboxAttachmentOptions {
  readonly catalog: MessageCatalog
  readonly policy: CommunicationPolicy
}

type ServiceStatus = 'active' | 'disposing' | 'disposed'

/** Owns Session attachment, private receiver registration, and Dispatcher identity. */
export class CommunicationService {
  readonly delegationChannels: DelegationChannels
  readonly #directory: SessionDirectory
  readonly #transport: MessageTransport
  readonly #limits: MailboxLimits
  readonly #clock: Clock
  readonly #identitySource: CommunicationIdentitySource
  readonly #gate = new SerialGate()
  readonly #mailboxes = new Map<string, SessionMailboxImpl>()
  readonly #dispatchers = new Map<SessionMailboxImpl, OutboxDispatcher>()
  readonly #ownedDeclarations = new Map<string, EffectLease<SessionDirectoryDeclaration>>()
  readonly #operations = new Set<Promise<unknown>>()
  #status: ServiceStatus = 'active'
  #disposeTask: Promise<void> | undefined

  constructor(options: CommunicationServiceOptions) {
    this.#directory = options.directory
    this.#transport = options.transport
    this.#limits = validateMailboxLimits(options.limits)
    this.delegationChannels = new DelegationChannels(this.#limits)
    this.#clock = options.clock ?? systemClock
    this.#identitySource = options.identitySource ?? systemCommunicationIdentitySource
  }

  /** Attach one active Session Handle to its address and private receiver route. */
  attach(handle: SessionHandle, options: MailboxAttachmentOptions): Promise<SessionMailbox> {
    this.#assertActive()
    const policy = validateCommunicationPolicy(options.policy)
    const task = this.#gate.run(async () => {
      this.#assertActive()
      if (handle.status !== 'open') {
        throw new CommunicationError('MESSAGE_MAILBOX_INACTIVE', 'Session Handle is not active for Mailbox attachment', {
          details: { address: handle.header.address, handleStatus: handle.status },
        })
      }
      for (const definition of communicationSessionEventDefinitions) {
        if (!handle.supportsEventDefinition(definition)) {
          throw new CommunicationError(
            'MESSAGE_SESSION_CATALOG_INCOMPATIBLE',
            'Session Catalog lacks a required communication event definition',
            { details: { type: definition.type, payloadVersion: definition.payloadVersion } },
          )
        }
      }
      if (this.#mailboxes.has(handle.header.address)) {
        throw new CommunicationError('MESSAGE_MAILBOX_ALREADY_ATTACHED', 'Session address already has an attached Mailbox', {
          details: { address: handle.header.address },
        })
      }
      const snapshot = projectMailbox(handle.snapshot(), options.catalog)
      if (handle.snapshot().lifecycle === 'ended') {
        const pending = snapshot.outbox.some(item => item.status === 'pending')
          || snapshot.inbox.some(item => item.status === 'pending')
        if (pending) {
          throw new CommunicationError('MESSAGE_STATE_INVALID', 'ended Session contains stranded communication', {
            details: { address: handle.header.address },
          })
        }
        throw new CommunicationError('MESSAGE_SESSION_ENDED', 'ended Session cannot attach a Mailbox', {
          details: { address: handle.header.address },
        })
      }

      let declaration = this.#ownedDeclarations.get(handle.header.address)
      let createdDeclaration = false
      const directoryStatus = this.#directory.status(handle.header.address)
      if (directoryStatus.kind === 'unknown') {
        declaration = await this.#directory.declare(handle.header.address, 'active')
        this.#ownedDeclarations.set(handle.header.address, declaration)
        createdDeclaration = true
      } else if (directoryStatus.kind === 'ended') {
        throw new CommunicationError('MESSAGE_SESSION_ENDED', 'Directory address is already ended', {
          details: { address: handle.header.address },
        })
      } else if (directoryStatus.kind === 'online') {
        throw new CommunicationError('MESSAGE_MAILBOX_ALREADY_ATTACHED', 'Directory address already has an online Mailbox', {
          details: { address: handle.header.address },
        })
      }

      let receiverLease: EffectLease<unknown> | undefined
      const mailbox = new SessionMailboxImpl({
        handle,
        channels: this.delegationChannels,
        catalog: options.catalog,
        policy,
        limits: this.#limits,
        clock: this.#clock,
        identitySource: this.#identitySource,
        onEnded: () => markDirectoryAddressEnded(this.#directory, handle.header.address),
        onDispose: async () => {
          await receiverLease?.dispose()
          if (this.#mailboxes.get(handle.header.address) === mailbox) this.#mailboxes.delete(handle.header.address)
          this.#dispatchers.delete(mailbox)
        },
      })
      try {
        receiverLease = registerDirectoryReceiver(this.#directory, handle.header.address, mailbox)
        this.#mailboxes.set(handle.header.address, mailbox)
        return mailbox
      } catch (cause) {
        if (createdDeclaration && declaration !== undefined) {
          this.#ownedDeclarations.delete(handle.header.address)
          await declaration.dispose()
        }
        throw cause
      }
    })
    return this.#track(task)
  }

  /** Lease-based protocol sends retain normal keyed Outbox durability and idempotency. */
  sendDelegationOnce(mailbox: SessionMailbox, lease: DelegationChannelLease, key: MessageSendKey, command: MessageSendCommand) {
    this.#assertActive()
    if (!(mailbox instanceof SessionMailboxImpl) || this.#mailboxes.get(mailbox.address) !== mailbox) {
      throw new CommunicationError('MESSAGE_MAILBOX_FOREIGN', 'protocol sender is not attached to this Service')
    }
    return mailbox.sendDelegationOnce(lease, key, command)
  }

  /** Return the sole Dispatcher associated with a Mailbox owned by this Service. */
  createDispatcher(mailbox: SessionMailbox): OutboxDispatcher {
    this.#assertActive()
    if (!(mailbox instanceof SessionMailboxImpl) || this.#mailboxes.get(mailbox.address) !== mailbox) {
      throw new CommunicationError('MESSAGE_MAILBOX_FOREIGN', 'Mailbox is not active in this Communication Service')
    }
    const implementation = mailbox
    const existing = this.#dispatchers.get(implementation)
    if (existing !== undefined) return existing
    const dispatcher = createOutboxDispatcher(implementation, this.#transport)
    this.#dispatchers.set(implementation, dispatcher)
    return dispatcher
  }

  /** Stop all attached Mailboxes and release only declarations owned by this Service. */
  dispose(): Promise<void> {
    if (this.#disposeTask !== undefined) return this.#disposeTask
    this.#status = 'disposing'
    this.delegationChannels.closeAdmission()
    const task = (async () => {
      await Promise.allSettled([...this.#operations])
      await this.delegationChannels.drain()
      const mailboxResults = await Promise.allSettled([...this.#mailboxes.values()].map(mailbox => mailbox.dispose()))
      const declarationResults = await Promise.allSettled([...this.#ownedDeclarations.values()].map(lease => lease.dispose()))
      this.#ownedDeclarations.clear()
      this.#status = 'disposed'
      const failures = [...mailboxResults, ...declarationResults]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Communication Service disposal failed')
    })()
    this.#disposeTask = task
    return task
  }

  #assertActive(): void {
    if (this.#status !== 'active') {
      throw new CommunicationError('MESSAGE_SERVICE_INACTIVE', `Communication Service is ${this.#status}`, {
        details: { status: this.#status },
      })
    }
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation)
    void operation.finally(() => this.#operations.delete(operation)).catch(() => undefined)
    return operation
  }
}

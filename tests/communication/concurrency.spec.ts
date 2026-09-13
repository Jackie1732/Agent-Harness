import { describe, expect, it } from 'vitest'
import {
  CommunicationService,
  MemorySessionBackend,
  createInProcessMessageTransport,
  createSessionDirectory,
  parseChannelId,
} from '../../src/index.js'
import type { MessageTransport, SessionBackend, SessionLogPosition, SessionWriter, StoredSessionEvent } from '../../src/index.js'
import { inboxAcceptedEvent } from '../../src/communication/session-events.js'
import { createDeferred } from '../helpers/deferred.js'
import {
  channelIds,
  communicationIdentities,
  createRepository,
  limits,
  messageCatalog,
  requestMessage,
} from './fixtures.js'

function blockingCommitBackend(
  eventType: string,
  started: ReturnType<typeof createDeferred<void>>,
  release: ReturnType<typeof createDeferred<void>>,
): SessionBackend {
  const inner = new MemorySessionBackend({ maxRecordBytes: 8192 })
  let block = true
  return {
    create: header => inner.create(header),
    readPrefix: (sessionId, through) => inner.readPrefix(sessionId, through),
    async openWriter(sessionId): Promise<SessionWriter> {
      const writer = await inner.openWriter(sessionId)
      return Object.freeze({
        header: writer.header,
        readCommitted: () => writer.readCommitted(),
        async append(position: SessionLogPosition, event: StoredSessionEvent) {
          if (block && event.type === eventType) {
            block = false
            started.resolve()
            await release.promise
          }
          return await writer.append(position, event)
        },
        dispose: () => writer.dispose(),
      })
    },
    dispose: () => inner.dispose(),
  }
}

describe('communication concurrency', () => {
  it('deduplicates a retry accepted while the recipient is ending', async () => {
    const started = createDeferred<void>()
    const release = createDeferred<void>()
    const repository = createRepository(blockingCommitBackend(inboxAcceptedEvent.type, started, release))
    const directory = createSessionDirectory()
    const transport = createInProcessMessageTransport(directory)
    const service = new CommunicationService({ directory, transport, limits, identitySource: communicationIdentities() })
    try {
      const senderHandle = await repository.create()
      const recipientHandle = await repository.create()
      const policy = { canSend: () => ({ kind: 'allow' as const }), canReceive: () => ({ kind: 'allow' as const }) }
      const sender = await service.attach(senderHandle, { catalog: messageCatalog, policy })
      const recipient = await service.attach(recipientHandle, { catalog: messageCatalog, policy })
      const outgoing = await sender.send(requestMessage, {
        kind: 'root', recipient: recipient.address, channelId: parseChannelId(channelIds[0]),
      }, { text: 'deduplicate while ending' })
      const dispatch = service.createDispatcher(sender).dispatch()
      await started.promise

      const ending = recipient.endSession()
      expect(recipient.status).toBe('ending')
      const retry = transport.deliver(outgoing.envelope, { signal: new AbortController().signal })
      release.resolve()

      expect(await dispatch).toMatchObject({ delivered: 1 })
      const duplicateOutcome = await retry
      expect(duplicateOutcome).toMatchObject({ kind: 'accepted', receipt: { messageId: outgoing.messageId } })
      await expect(ending).rejects.toMatchObject({ code: 'MESSAGE_PENDING' })
      expect(recipient.status).toBe('open')
      expect(recipient.snapshot().inbox).toHaveLength(1)
    } finally {
      release.resolve()
      await service.dispose()
      await transport.dispose()
      await directory.dispose()
      await repository.dispose()
    }
  })

  it('shares one dispatch run and waits for its active attempt before Mailbox disposal', async () => {
    const repository = createRepository()
    const directory = createSessionDirectory()
    const started = createDeferred<void>()
    const release = createDeferred<void>()
    const transport: MessageTransport = {
      async deliver() {
        started.resolve()
        await release.promise
        return { kind: 'retry', code: 'recipient-offline' }
      },
      async dispose() {},
    }
    const service = new CommunicationService({
      directory,
      transport,
      limits,
      identitySource: communicationIdentities(),
    })
    try {
      const senderHandle = await repository.create()
      const recipientHandle = await repository.create()
      const sender = await service.attach(senderHandle, { catalog: messageCatalog, policy: {
        canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }),
      } })
      await sender.send(requestMessage, {
        kind: 'root', recipient: recipientHandle.header.address, channelId: parseChannelId(channelIds[0]),
      }, { text: 'wait' })
      const dispatcher = service.createDispatcher(sender)
      const firstRun = dispatcher.dispatch()
      const secondRun = dispatcher.dispatch()
      expect(firstRun).toBe(secondRun)
      await started.promise

      const disposal = sender.dispose()
      let disposed = false
      void disposal.then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      expect(directory.status(sender.address).kind).toBe('online')

      release.resolve()
      expect(await firstRun).toMatchObject({ startedAttempts: 1, retryable: 1 })
      await disposal
      expect(directory.status(sender.address).kind).toBe('known-offline')
    } finally {
      release.resolve()
      await service.dispose()
      await directory.dispose()
      await repository.dispose()
    }
  })

  it('does not start another attempt after the caller aborts the current one', async () => {
    const repository = createRepository()
    const directory = createSessionDirectory()
    const started = createDeferred<void>()
    const transport: MessageTransport = {
      async deliver(_envelope, options) {
        started.resolve()
        await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
        return { kind: 'retry', code: 'attempt-interrupted' }
      },
      async dispose() {},
    }
    const service = new CommunicationService({ directory, transport, limits, identitySource: communicationIdentities() })
    try {
      const senderHandle = await repository.create()
      const firstRecipient = await repository.create()
      const secondRecipient = await repository.create()
      const sender = await service.attach(senderHandle, { catalog: messageCatalog, policy: {
        canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }),
      } })
      await sender.send(requestMessage, {
        kind: 'root', recipient: firstRecipient.header.address, channelId: parseChannelId(channelIds[0]),
      }, { text: 'first' })
      await sender.send(requestMessage, {
        kind: 'root', recipient: secondRecipient.header.address, channelId: parseChannelId(channelIds[1]),
      }, { text: 'second' })
      const controller = new AbortController()
      const run = service.createDispatcher(sender).dispatch({ signal: controller.signal })
      await started.promise
      controller.abort()

      expect(await run).toMatchObject({ startedAttempts: 1, retryable: 1, stoppedBy: 'aborted' })
      expect(sender.snapshot().outbox.map(item => item.attemptCount)).toEqual([1, 0])
    } finally {
      await service.dispose()
      await directory.dispose()
      await repository.dispose()
    }
  })

  it('settles an active attempt before an explicit Outbox abandonment', async () => {
    const repository = createRepository()
    const directory = createSessionDirectory()
    const started = createDeferred<void>()
    const release = createDeferred<void>()
    const transport: MessageTransport = {
      async deliver() {
        started.resolve()
        await release.promise
        return { kind: 'retry', code: 'recipient-offline' }
      },
      async dispose() {},
    }
    const service = new CommunicationService({ directory, transport, limits, identitySource: communicationIdentities() })
    try {
      const senderHandle = await repository.create()
      const recipientHandle = await repository.create()
      const sender = await service.attach(senderHandle, { catalog: messageCatalog, policy: {
        canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }),
      } })
      const outgoing = await sender.send(requestMessage, {
        kind: 'root', recipient: recipientHandle.header.address, channelId: parseChannelId(channelIds[0]),
      }, { text: 'stop after attempt' })
      const dispatch = service.createDispatcher(sender).dispatch()
      await started.promise
      const abandonment = sender.abandonOutgoing(outgoing.messageId, 'caller-requested')
      let abandoned = false
      void abandonment.then(() => { abandoned = true })
      await Promise.resolve()
      expect(abandoned).toBe(false)

      release.resolve()
      await dispatch
      expect(await abandonment).toMatchObject({ status: 'abandoned', abandonReason: 'caller-requested', attemptCount: 1 })
    } finally {
      release.resolve()
      await service.dispose()
      await directory.dispose()
      await repository.dispose()
    }
  })
})

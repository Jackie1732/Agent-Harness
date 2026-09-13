import { describe, expect, it } from 'vitest'
import {
  CommunicationService,
  createSessionDirectory,
  parseChannelId,
} from '../../src/index.js'
import type { MessageTransport } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'
import {
  channelIds,
  communicationIdentities,
  createRepository,
  limits,
  messageCatalog,
  requestMessage,
} from './fixtures.js'

describe('communication concurrency', () => {
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

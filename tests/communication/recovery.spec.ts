import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CommunicationService,
  FileSessionBackend,
  createInProcessMessageTransport,
  createSessionDirectory,
  parseChannelId,
  parseSessionId,
  projectMailbox,
} from '../../src/index.js'
import {
  inboxAcceptedEvent,
  outboxAttemptFailedEvent,
  outboxAttemptStartedEvent,
  outboxAbandonedEvent,
} from '../../src/communication/session-events.js'
import {
  channelIds,
  communicationIdentities,
  createCommunicationService,
  createRepository,
  limits,
  loseFirstCommitAcknowledgement,
  messageCatalog,
  requestMessage,
  sessionIdentities,
  sessionIds,
} from './fixtures.js'

describe('communication recovery and Session lineage', () => {
  it('settles a recovered open attempt before allocating its next attempt number', async () => {
    const repository = createRepository()
    const firstRuntime = createCommunicationService()
    const senderHandle = await repository.create()
    const recipientHandle = await repository.create()
    const sender = await firstRuntime.service.attach(senderHandle, { catalog: messageCatalog, policy: firstRuntime.policy })
    const outgoing = await sender.send(requestMessage, {
      kind: 'root',
      recipient: recipientHandle.header.address,
      channelId: parseChannelId(channelIds[0]),
    }, { text: 'recover' })
    await senderHandle.append(outboxAttemptStartedEvent, { messageId: outgoing.messageId, attempt: 1 })
    await firstRuntime.service.dispose()
    await firstRuntime.transport.dispose()
    await firstRuntime.directory.dispose()

    const secondRuntime = createCommunicationService()
    try {
      const reopenedSender = await secondRuntime.service.attach(senderHandle, { catalog: messageCatalog, policy: secondRuntime.policy })
      const recipient = await secondRuntime.service.attach(recipientHandle, { catalog: messageCatalog, policy: secondRuntime.policy })
      const report = await secondRuntime.service.createDispatcher(reopenedSender).dispatch()

      expect(report).toMatchObject({ startedAttempts: 1, delivered: 1 })
      expect(reopenedSender.snapshot().outbox[0]).toMatchObject({ status: 'delivered', attemptCount: 2 })
      expect(recipient.snapshot().inbox).toHaveLength(1)
    } finally {
      await secondRuntime.service.dispose()
      await secondRuntime.transport.dispose()
      await secondRuntime.directory.dispose()
      await repository.dispose()
    }
  })

  it('settles a recovered open attempt before explicit abandonment', async () => {
    const repository = createRepository()
    const firstRuntime = createCommunicationService()
    const senderHandle = await repository.create()
    const recipientHandle = await repository.create()
    const senderId = senderHandle.header.sessionId
    try {
      const sender = await firstRuntime.service.attach(senderHandle, { catalog: messageCatalog, policy: firstRuntime.policy })
      const outgoing = await sender.send(requestMessage, {
        kind: 'root', recipient: recipientHandle.header.address, channelId: parseChannelId(channelIds[0]),
      }, { text: 'recover before abandon' })
      await senderHandle.append(outboxAttemptStartedEvent, { messageId: outgoing.messageId, attempt: 1 })
      await firstRuntime.service.dispose()
      await firstRuntime.transport.dispose()
      await firstRuntime.directory.dispose()
      await senderHandle.dispose()
      await recipientHandle.dispose()

      const secondRuntime = createCommunicationService()
      try {
        const reopenedHandle = await repository.open(senderId)
        const reopened = await secondRuntime.service.attach(reopenedHandle, {
          catalog: messageCatalog,
          policy: secondRuntime.policy,
        })
        expect(await reopened.abandonOutgoing(outgoing.messageId, 'caller-requested')).toMatchObject({
          status: 'abandoned',
          attemptCount: 1,
          lastFailure: { attempt: 1, code: 'transport-outcome-unknown' },
        })
        expect(reopenedHandle.snapshot().history.at(-1)?.events.slice(-2).map(event => event.stored.type)).toEqual([
          outboxAttemptFailedEvent.type,
          outboxAbandonedEvent.type,
        ])
        await secondRuntime.service.dispose()
        await reopenedHandle.dispose()
      } finally {
        await secondRuntime.service.dispose()
        await secondRuntime.transport.dispose()
        await secondRuntime.directory.dispose()
      }
    } finally {
      await firstRuntime.service.dispose()
      await firstRuntime.transport.dispose()
      await firstRuntime.directory.dispose()
      await repository.dispose()
    }
  })

  it('gives a fork an empty locally owned mailbox and a fresh Channel sequence', async () => {
    const repository = createRepository()
    const runtime = createCommunicationService()
    try {
      const parentHandle = await repository.create()
      const peerHandle = await repository.create()
      const parent = await runtime.service.attach(parentHandle, { catalog: messageCatalog, policy: runtime.policy })
      await parent.send(requestMessage, {
        kind: 'root', recipient: peerHandle.header.address, channelId: parseChannelId(channelIds[0]),
      }, { text: 'parent' })
      const childHandle = await repository.fork(parentHandle.header.sessionId)

      expect(projectMailbox(childHandle.snapshot(), messageCatalog)).toMatchObject({ outbox: [], inbox: [] })
      const child = await runtime.service.attach(childHandle, { catalog: messageCatalog, policy: runtime.policy })
      const childMessage = await child.send(requestMessage, {
        kind: 'root', recipient: peerHandle.header.address, channelId: parseChannelId(channelIds[0]),
      }, { text: 'child' })
      expect(childMessage.envelope.channelSequence).toBe(1)
    } finally {
      await runtime.service.dispose()
      await runtime.transport.dispose()
      await runtime.directory.dispose()
      await repository.dispose()
    }
  })

  it('reopens File Sessions in a fresh object graph and continues pending delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-communication-'))
    const senderId = parseSessionId(sessionIds[0])
    const recipientId = parseSessionId(sessionIds[1])
    try {
      const firstRepository = createRepository(
        new FileSessionBackend({ root, maxRecordBytes: 8192 }),
        sessionIdentities([senderId, recipientId]),
      )
      const firstRuntime = createCommunicationService()
      const senderHandle = await firstRepository.create()
      const recipientHandle = await firstRepository.create()
      const sender = await firstRuntime.service.attach(senderHandle, { catalog: messageCatalog, policy: firstRuntime.policy })
      await sender.send(requestMessage, {
        kind: 'root', recipient: recipientHandle.header.address, channelId: parseChannelId(channelIds[0]),
      }, { text: 'persisted' })
      await firstRuntime.service.dispose()
      await firstRuntime.transport.dispose()
      await firstRuntime.directory.dispose()
      await firstRepository.dispose()

      const secondRepository = createRepository(new FileSessionBackend({ root, maxRecordBytes: 8192 }))
      const directory = createSessionDirectory()
      const transport = createInProcessMessageTransport(directory)
      const service = new CommunicationService({
        directory,
        transport,
        limits,
        identitySource: communicationIdentities(),
      })
      try {
        const reopenedSender = await secondRepository.open(senderId)
        const reopenedRecipient = await secondRepository.open(recipientId)
        const senderMailbox = await service.attach(reopenedSender, { catalog: messageCatalog, policy: {
          canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }),
        } })
        const recipientMailbox = await service.attach(reopenedRecipient, { catalog: messageCatalog, policy: {
          canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }),
        } })

        expect(senderMailbox.snapshot().outbox[0]?.status).toBe('pending')
        expect(await service.createDispatcher(senderMailbox).dispatch()).toMatchObject({ delivered: 1 })
        expect(recipientMailbox.snapshot().inbox[0]?.envelope.payload).toEqual({ text: 'persisted' })
      } finally {
        await service.dispose()
        await transport.dispose()
        await directory.dispose()
        await secondRepository.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers an ambiguous File Inbox commit and deduplicates the retry in a fresh object graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-communication-ambiguous-inbox-'))
    const senderId = parseSessionId(sessionIds[0])
    const recipientId = parseSessionId(sessionIds[1])
    try {
      const firstRepository = createRepository(
        loseFirstCommitAcknowledgement(
          new FileSessionBackend({ root, maxRecordBytes: 8192 }),
          inboxAcceptedEvent.type,
        ),
        sessionIdentities([senderId, recipientId]),
      )
      const firstRuntime = createCommunicationService()
      const senderHandle = await firstRepository.create()
      const recipientHandle = await firstRepository.create()
      try {
        const sender = await firstRuntime.service.attach(senderHandle, { catalog: messageCatalog, policy: firstRuntime.policy })
        const recipient = await firstRuntime.service.attach(recipientHandle, { catalog: messageCatalog, policy: firstRuntime.policy })
        const outgoing = await sender.send(requestMessage, {
          kind: 'root', recipient: recipient.address, channelId: parseChannelId(channelIds[0]),
        }, { text: 'ambiguous inbox commit' })

        expect(await firstRuntime.service.createDispatcher(sender).dispatch()).toMatchObject({
          retryable: 1,
          remainingPending: 1,
        })
        expect(recipient.status).toBe('faulted')
        expect(sender.snapshot().outbox[0]).toMatchObject({
          messageId: outgoing.messageId,
          lastFailure: { attempt: 1, code: 'receiver-outcome-unknown' },
        })
      } finally {
        await firstRuntime.service.dispose()
        await firstRuntime.transport.dispose()
        await firstRuntime.directory.dispose()
        await senderHandle.dispose()
        await recipientHandle.dispose()
        await firstRepository.dispose()
      }

      const secondRepository = createRepository(new FileSessionBackend({ root, maxRecordBytes: 8192 }))
      const secondRuntime = createCommunicationService()
      try {
        const reopenedSenderHandle = await secondRepository.open(senderId)
        const reopenedRecipientHandle = await secondRepository.open(recipientId)
        const sender = await secondRuntime.service.attach(reopenedSenderHandle, {
          catalog: messageCatalog,
          policy: secondRuntime.policy,
        })
        const recipient = await secondRuntime.service.attach(reopenedRecipientHandle, {
          catalog: messageCatalog,
          policy: secondRuntime.policy,
        })

        expect(recipient.snapshot().inbox).toHaveLength(1)
        expect(await secondRuntime.service.createDispatcher(sender).dispatch()).toMatchObject({ delivered: 1 })
        expect(sender.snapshot().outbox[0]).toMatchObject({ status: 'delivered', attemptCount: 2 })
        expect(recipient.snapshot().inbox).toHaveLength(1)
        await secondRuntime.service.dispose()
        await reopenedSenderHandle.dispose()
        await reopenedRecipientHandle.dispose()
      } finally {
        await secondRuntime.service.dispose()
        await secondRuntime.transport.dispose()
        await secondRuntime.directory.dispose()
        await secondRepository.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

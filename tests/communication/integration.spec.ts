import { afterEach, describe, expect, it } from 'vitest'
import {
  CommunicationService,
  createInProcessMessageTransport,
  createSessionDirectory,
  decodeMessageEnvelope,
  formatSessionAddress,
  messageEnvelopeDigest,
  parseChannelId,
  parseMessageId,
  parseSessionId,
} from '../../src/index.js'
import type { MessageTransport } from '../../src/index.js'
import { inboxAcceptedEvent } from '../../src/communication/session-events.js'
import {
  channelIds,
  communicationIdentities,
  createCommunicationService,
  createRepository,
  limits,
  messageCatalog,
  replyMessage,
  requestMessage,
} from './fixtures.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
})

describe('Session communication', () => {
  it('persists send, delivery, processing, and reply as independent facts', async () => {
    const repository = createRepository()
    const runtime = createCommunicationService()
    cleanups.push(() => repository.dispose(), () => runtime.service.dispose(), () => runtime.transport.dispose(), () => runtime.directory.dispose())
    const senderHandle = await repository.create()
    const recipientHandle = await repository.create()
    const sender = await runtime.service.attach(senderHandle, { catalog: messageCatalog, policy: runtime.policy })
    const recipient = await runtime.service.attach(recipientHandle, { catalog: messageCatalog, policy: runtime.policy })
    const channelId = parseChannelId(channelIds[0])

    const accepted = await sender.send(requestMessage, { kind: 'root', recipient: recipient.address, channelId }, { text: 'question' })
    expect(sender.snapshot().outbox[0]?.status).toBe('pending')
    expect(recipient.snapshot().inbox).toHaveLength(0)

    const sent = await runtime.service.createDispatcher(sender).dispatch()
    expect(sent).toMatchObject({ startedAttempts: 1, delivered: 1, remainingPending: 0 })
    expect(sender.snapshot().outbox[0]).toMatchObject({ status: 'delivered', messageId: accepted.messageId })
    const incoming = recipient.snapshot().inbox[0]!
    expect(incoming).toMatchObject({ status: 'pending', supported: true })

    const reply = await recipient.reply(incoming.messageId, replyMessage, { text: 'answer' })
    await recipient.markProcessed(incoming.messageId)
    expect(recipient.snapshot().inbox[0]?.status).toBe('processed')
    expect(reply.envelope).toMatchObject({
      correlationId: accepted.messageId,
      causationId: accepted.messageId,
      replyTo: accepted.messageId,
    })
    await runtime.service.createDispatcher(recipient).dispatch()
    expect(sender.snapshot().inbox[0]?.envelope.payload).toEqual({ text: 'answer' })
  })

  it('does not let an offline Channel head block another recipient', async () => {
    const repository = createRepository()
    const runtime = createCommunicationService()
    cleanups.push(() => repository.dispose(), () => runtime.service.dispose(), () => runtime.transport.dispose(), () => runtime.directory.dispose())
    const senderHandle = await repository.create()
    const onlineHandle = await repository.create()
    const offlineAddress = formatSessionAddress(parseSessionId('00000000-0000-4000-8000-000000000199'))
    const offlineDeclaration = await runtime.directory.declare(offlineAddress, 'active')
    cleanups.push(() => offlineDeclaration.dispose())
    const sender = await runtime.service.attach(senderHandle, { catalog: messageCatalog, policy: runtime.policy })
    const online = await runtime.service.attach(onlineHandle, { catalog: messageCatalog, policy: runtime.policy })

    await sender.send(requestMessage, { kind: 'root', recipient: offlineAddress, channelId: parseChannelId(channelIds[0]) }, { text: 'wait' })
    await sender.send(requestMessage, { kind: 'root', recipient: online.address, channelId: parseChannelId(channelIds[1]) }, { text: 'go' })
    const report = await runtime.service.createDispatcher(sender).dispatch()

    expect(report).toMatchObject({ startedAttempts: 2, delivered: 1, retryable: 1, remainingPending: 1 })
    expect(online.snapshot().inbox).toHaveLength(1)
  })

  it('retries an unknown receipt with one Message identity and one Inbox record', async () => {
    const repository = createRepository()
    const directory = createSessionDirectory()
    const inner = createInProcessMessageTransport(directory)
    let loseFirstReceipt = true
    const lossy: MessageTransport = {
      async deliver(envelope, options) {
        const outcome = await inner.deliver(envelope, options)
        if (loseFirstReceipt && outcome.kind === 'accepted') {
          loseFirstReceipt = false
          throw new Error('receipt lost')
        }
        return outcome
      },
      async dispose() { await inner.dispose() },
    }
    const service = new CommunicationService({
      directory,
      transport: lossy,
      limits,
      identitySource: communicationIdentities(),
      clock: { now: () => 1_789_257_600_000 },
    })
    cleanups.push(() => repository.dispose(), () => service.dispose(), () => lossy.dispose(), () => directory.dispose())
    const first = await repository.create()
    const second = await repository.create()
    const sender = await service.attach(first, { catalog: messageCatalog, policy: { canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }) } })
    const recipient = await service.attach(second, { catalog: messageCatalog, policy: { canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }) } })
    const outgoing = await sender.send(requestMessage, {
      kind: 'root', recipient: recipient.address, channelId: parseChannelId(channelIds[0]),
    }, { text: 'once' })

    expect(await service.createDispatcher(sender).dispatch()).toMatchObject({ retryable: 1 })
    expect(recipient.snapshot().inbox).toHaveLength(1)
    expect(await service.createDispatcher(sender).dispatch()).toMatchObject({ delivered: 1 })
    expect(recipient.snapshot().inbox).toHaveLength(1)
    expect(sender.snapshot().outbox[0]).toMatchObject({ messageId: outgoing.messageId, attemptCount: 2, status: 'delivered' })
  })

  it('keeps same-Channel messages ordered under Inbox backpressure', async () => {
    const repository = createRepository()
    const runtime = createCommunicationService({ maxPendingInbox: 1 })
    cleanups.push(() => repository.dispose(), () => runtime.service.dispose(), () => runtime.transport.dispose(), () => runtime.directory.dispose())
    const first = await repository.create()
    const second = await repository.create()
    const sender = await runtime.service.attach(first, { catalog: messageCatalog, policy: runtime.policy })
    const recipient = await runtime.service.attach(second, { catalog: messageCatalog, policy: runtime.policy })
    const channelId = parseChannelId(channelIds[0])
    await sender.send(requestMessage, { kind: 'root', recipient: recipient.address, channelId }, { text: 'first' })
    await sender.send(requestMessage, { kind: 'root', recipient: recipient.address, channelId }, { text: 'second' })

    expect(await runtime.service.createDispatcher(sender).dispatch()).toMatchObject({ delivered: 1, retryable: 1 })
    expect(recipient.snapshot().inbox.map(item => item.envelope.payload)).toEqual([{ text: 'first' }])
    await recipient.markProcessed(recipient.snapshot().inbox[0]!.messageId)
    expect(await runtime.service.createDispatcher(sender).dispatch()).toMatchObject({ delivered: 1 })
    expect(recipient.snapshot().inbox.map(item => item.envelope.payload)).toEqual([{ text: 'first' }, { text: 'second' }])
  })

  it('requires explicit settlement before ending a communication Session', async () => {
    const repository = createRepository()
    const runtime = createCommunicationService()
    cleanups.push(() => repository.dispose(), () => runtime.service.dispose(), () => runtime.transport.dispose(), () => runtime.directory.dispose())
    const handle = await repository.create()
    const mailbox = await runtime.service.attach(handle, { catalog: messageCatalog, policy: runtime.policy })
    const unknown = formatSessionAddress(parseSessionId('00000000-0000-4000-8000-000000000198'))
    const outgoing = await mailbox.send(requestMessage, {
      kind: 'root', recipient: unknown, channelId: parseChannelId(channelIds[0]),
    }, { text: 'pending' })

    await expect(mailbox.endSession()).rejects.toMatchObject({ code: 'MESSAGE_PENDING' })
    expect(mailbox.status).toBe('open')
    await mailbox.abandonOutgoing(outgoing.messageId, 'caller-requested')
    await mailbox.endSession('complete')
    expect(mailbox.status).toBe('ended')
    expect(runtime.directory.status(mailbox.address).kind).toBe('ended')
  })

  it('checks outgoing policy before commit and records an incoming policy denial as rejection', async () => {
    const repository = createRepository()
    const runtime = createCommunicationService()
    cleanups.push(() => repository.dispose(), () => runtime.service.dispose(), () => runtime.transport.dispose(), () => runtime.directory.dispose())
    const senderHandle = await repository.create()
    const recipientHandle = await repository.create()
    const sender = await runtime.service.attach(senderHandle, {
      catalog: messageCatalog,
      policy: {
        canSend: input => input.type === replyMessage.type
          ? { kind: 'deny', reasonCode: 'reply-disabled' }
          : { kind: 'allow' },
        canReceive: () => ({ kind: 'allow' }),
      },
    })
    const recipient = await runtime.service.attach(recipientHandle, {
      catalog: messageCatalog,
      policy: {
        canSend: () => ({ kind: 'allow' }),
        canReceive: () => ({ kind: 'deny', reasonCode: 'request-disabled' }),
      },
    })
    const channelId = parseChannelId(channelIds[0])

    await expect(sender.send(replyMessage, {
      kind: 'root', recipient: recipient.address, channelId,
    }, { text: 'blocked locally' })).rejects.toMatchObject({ code: 'MESSAGE_SEND_FORBIDDEN' })
    expect(sender.snapshot().outbox).toHaveLength(0)

    await sender.send(requestMessage, {
      kind: 'root', recipient: recipient.address, channelId,
    }, { text: 'blocked remotely' })
    expect(await runtime.service.createDispatcher(sender).dispatch()).toMatchObject({ rejected: 1 })
    expect(sender.snapshot().outbox[0]).toMatchObject({ status: 'rejected', rejection: 'receive-forbidden' })
    expect(recipient.snapshot().inbox).toHaveLength(0)
  })

  it('rejects the same Message identity when its complete Envelope differs', async () => {
    const repository = createRepository()
    const runtime = createCommunicationService()
    cleanups.push(() => repository.dispose(), () => runtime.service.dispose(), () => runtime.transport.dispose(), () => runtime.directory.dispose())
    const senderHandle = await repository.create()
    const recipientHandle = await repository.create()
    const conflicting = decodeMessageEnvelope({
      envelopeVersion: 1,
      messageId: parseMessageId('10000000-0000-4000-8000-000000000101'),
      sender: senderHandle.header.address,
      recipient: recipientHandle.header.address,
      channelId: parseChannelId(channelIds[0]),
      channelSequence: 1,
      correlationId: parseMessageId('10000000-0000-4000-8000-000000000101'),
      createdAt: '2026-09-13T00:00:00.000Z',
      type: requestMessage.type,
      payloadVersion: requestMessage.payloadVersion,
      payload: { text: 'original' },
    })
    await recipientHandle.append(inboxAcceptedEvent, {
      envelope: conflicting,
      digest: messageEnvelopeDigest(conflicting),
    })
    const sender = await runtime.service.attach(senderHandle, { catalog: messageCatalog, policy: runtime.policy })
    const recipient = await runtime.service.attach(recipientHandle, { catalog: messageCatalog, policy: runtime.policy })
    await sender.send(requestMessage, {
      kind: 'root', recipient: recipient.address, channelId: parseChannelId(channelIds[0]),
    }, { text: 'different' })

    expect(await runtime.service.createDispatcher(sender).dispatch()).toMatchObject({ rejected: 1 })
    expect(sender.snapshot().outbox[0]).toMatchObject({ status: 'rejected', rejection: 'message-id-conflict' })
    expect(recipient.snapshot().inbox).toHaveLength(1)
  })
})

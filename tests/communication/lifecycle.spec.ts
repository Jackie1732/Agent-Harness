import { expect, it } from 'vitest'
import { CommunicationService, allowAllCommunicationPolicy, createInProcessMessageTransport, createSessionDirectory, parseChannelId } from '../../src/index.js'
import type { MessageDeliveryOutcome, MessageTransport, SessionMailbox } from '../../src/index.js'
import { channelIds, createRepository, limits, messageCatalog, requestMessage } from './fixtures.js'
import { createDeferred } from '../helpers/deferred.js'

it('publishes the same Mailbox release task before Transport abort callbacks', async () => {
  const repository = createRepository()
  const directory = createSessionDirectory()
  const entered = createDeferred<void>()
  const outcome = createDeferred<MessageDeliveryOutcome>()
  let mailbox: SessionMailbox
  let reentered: Promise<void> | undefined
  const transport: MessageTransport = {
    async deliver(_envelope, { signal }) {
      signal.addEventListener('abort', () => {
        reentered = mailbox.dispose()
        outcome.resolve({ kind: 'retry', code: 'attempt-interrupted' })
      }, { once: true })
      entered.resolve()
      return await outcome.promise
    },
    async dispose() {},
  }
  const service = new CommunicationService({ directory, transport, limits })
  try {
    const source = await repository.create()
    const target = await repository.create()
    mailbox = await service.attach(source, { catalog: messageCatalog, policy: allowAllCommunicationPolicy })
    await mailbox.send(requestMessage, {
      kind: 'root', recipient: target.header.address, channelId: parseChannelId(channelIds[0]),
    }, { text: 'pending' })
    const running = service.createDispatcher(mailbox).dispatch()
    await entered.promise
    const primary = mailbox.dispose()
    await Promise.all([running, primary, reentered])
    expect(reentered).toBe(primary)
  } finally {
    outcome.resolve({ kind: 'retry', code: 'attempt-interrupted' })
    await service.dispose()
    await transport.dispose()
    await directory.dispose()
    await repository.dispose()
  }
})

it('closes attached Mailbox admission synchronously on Service release', async () => {
  const repository = createRepository()
  const directory = createSessionDirectory()
  const transport = createInProcessMessageTransport(directory)
  const service = new CommunicationService({ directory, transport, limits })
  try {
    const source = await repository.create()
    const target = await repository.create()
    const mailbox = await service.attach(source, { catalog: messageCatalog, policy: allowAllCommunicationPolicy })
    const release = service.dispose()
    expect(() => mailbox.send(requestMessage, {
      kind: 'root', recipient: target.header.address, channelId: parseChannelId(channelIds[0]),
    }, { text: 'late' })).toThrowError(expect.objectContaining({ code: 'MESSAGE_MAILBOX_INACTIVE' }))
    await release
    expect(source.snapshot().history.at(-1)!.events).toHaveLength(0)
  } finally {
    await service.dispose()
    await transport.dispose()
    await directory.dispose()
    await repository.dispose()
  }
})

it('stops every Mailbox before cancellation can submit work to another attached Session', async () => {
  const repository = createRepository()
  const directory = createSessionDirectory()
  const entered = createDeferred<void>()
  const outcome = createDeferred<MessageDeliveryOutcome>()
  let peer: SessionMailbox
  let reentered: Promise<void> | undefined
  let lateSendError: unknown
  const transport: MessageTransport = {
    async deliver(_envelope, { signal }) {
      signal.addEventListener('abort', () => {
        reentered = service.dispose()
        try {
          void peer.send(requestMessage, {
            kind: 'root', recipient: sender.address, channelId: parseChannelId(channelIds[0]),
          }, { text: 'late peer send' })
        } catch (cause) { lateSendError = cause }
        outcome.resolve({ kind: 'retry', code: 'attempt-interrupted' })
      }, { once: true })
      entered.resolve()
      return await outcome.promise
    },
    async dispose() {},
  }
  const service = new CommunicationService({ directory, transport, limits })
  const senderHandle = await repository.create()
  const peerHandle = await repository.create()
  const sender = await service.attach(senderHandle, { catalog: messageCatalog, policy: allowAllCommunicationPolicy })
  peer = await service.attach(peerHandle, { catalog: messageCatalog, policy: allowAllCommunicationPolicy })
  try {
    await sender.send(requestMessage, {
      kind: 'root', recipient: peer.address, channelId: parseChannelId(channelIds[0]),
    }, { text: 'active attempt' })
    const run = service.createDispatcher(sender).dispatch()
    await entered.promise
    const closing = service.dispose()
    expect(reentered).toBe(closing)
    expect(lateSendError).toMatchObject({ code: 'MESSAGE_MAILBOX_INACTIVE' })
    expect(await run).toMatchObject({ startedAttempts: 1, retryable: 1 })
    await closing
    expect(peerHandle.snapshot().history.at(-1)!.events).toHaveLength(0)
    expect(senderHandle.status).toBe('open')
    expect(peerHandle.status).toBe('open')
    const external = await directory.declare(peer.address, 'active')
    await external.dispose()
  } finally {
    outcome.resolve({ kind: 'retry', code: 'attempt-interrupted' })
    await service.dispose()
    await transport.dispose()
    await directory.dispose()
    await repository.dispose()
  }
})

it('settles an already admitted send while rejecting new work during Service release', async () => {
  const repository = createRepository()
  const directory = createSessionDirectory()
  const transport = createInProcessMessageTransport(directory)
  const service = new CommunicationService({ directory, transport, limits })
  try {
    const handle = await repository.create()
    const target = await repository.create()
    const mailbox = await service.attach(handle, { catalog: messageCatalog, policy: allowAllCommunicationPolicy })
    const request = { kind: 'root' as const, recipient: target.header.address, channelId: parseChannelId(channelIds[0]) }
    const admitted = mailbox.send(requestMessage, request, { text: 'admitted before close' })
    const closing = service.dispose()
    expect(() => mailbox.send(requestMessage, request, { text: 'after close' }))
      .toThrow(expect.objectContaining({ code: 'MESSAGE_MAILBOX_INACTIVE' }))
    const accepted = await admitted
    await closing
    expect(handle.snapshot().history.at(-1)!.events.map(event => event.stored.type)).toEqual(['communication/outbox-accepted'])
    const replacement = new CommunicationService({ directory, transport, limits })
    try {
      const reopened = await replacement.attach(handle, { catalog: messageCatalog, policy: allowAllCommunicationPolicy })
      expect(reopened.snapshot().outbox[0]).toMatchObject({ messageId: accepted.messageId, status: 'pending', attemptCount: 0 })
    } finally { await replacement.dispose() }
  } finally {
    await service.dispose()
    await transport.dispose()
    await directory.dispose()
    await repository.dispose()
  }
})

import { expect, it } from 'vitest'
import {
  CommunicationService,
  allowAllCommunicationPolicy,
  createInProcessMessageTransport,
  createSessionDirectory,
  parseChannelId,
} from '../../src/index.js'
import type { MessageDeliveryOutcome, MessageTransport } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'
import { channelIds, createRepository, limits, messageCatalog, requestMessage } from './fixtures.js'

const attachment = { catalog: messageCatalog, policy: allowAllCommunicationPolicy }

it('rejects a second owner across independent Services until the active attempt and receiver release', async () => {
  const repository = createRepository()
  const directories = [createSessionDirectory(), createSessionDirectory()]
  const entered = createDeferred<void>()
  const outcome = createDeferred<MessageDeliveryOutcome>()
  const transport: MessageTransport = {
    async deliver() { entered.resolve(); return await outcome.promise },
    async dispose() {},
  }
  const left = new CommunicationService({ directory: directories[0]!, transport, limits })
  const local = createInProcessMessageTransport(directories[1]!)
  const right = new CommunicationService({ directory: directories[1]!, transport: local, limits })
  try {
    const handle = await repository.create()
    const target = await repository.create()
    const mailbox = await left.attach(handle, attachment)
    await expect(right.attach(handle, attachment)).rejects.toMatchObject({ code: 'MESSAGE_MAILBOX_ALREADY_ATTACHED' })
    expect(directories[1]!.status(mailbox.address).kind).toBe('unknown')
    await mailbox.send(requestMessage, {
      kind: 'root', recipient: target.header.address, channelId: parseChannelId(channelIds[0]),
    }, { text: 'exclusive attempt' })
    const run = left.createDispatcher(mailbox).dispatch()
    await entered.promise
    const closing = mailbox.dispose()
    await expect(right.attach(handle, attachment)).rejects.toMatchObject({ code: 'MESSAGE_MAILBOX_ALREADY_ATTACHED' })
    outcome.resolve({ kind: 'retry', code: 'recipient-offline' })
    await Promise.all([run, closing])
    const replacement = await right.attach(handle, attachment)
    expect(replacement.snapshot().outbox[0]).toMatchObject({ status: 'pending', attemptCount: 1 })
    expect(replacement.snapshot().outbox[0]).not.toHaveProperty('openAttempt')
    expect(handle.status).toBe('open')
  } finally {
    outcome.resolve({ kind: 'retry', code: 'recipient-offline' })
    await left.dispose()
    await right.dispose()
    await transport.dispose()
    await local.dispose()
    for (const directory of directories) await directory.dispose()
    await repository.dispose()
  }
})

it('rolls back a declaration and Handle ownership when Service closes during attachment', async () => {
  const repository = createRepository()
  const directory = createSessionDirectory()
  const transport = createInProcessMessageTransport(directory)
  const service = new CommunicationService({ directory, transport, limits })
  const replacement = new CommunicationService({ directory, transport, limits })
  try {
    const handle = await repository.create()
    const attaching = service.attach(handle, attachment)
    await Promise.resolve()
    expect(directory.status(handle.header.address).kind).toBe('known-offline')
    const closing = service.dispose()
    await expect(attaching).rejects.toMatchObject({ code: 'MESSAGE_SERVICE_INACTIVE' })
    await closing
    expect(directory.status(handle.header.address).kind).toBe('unknown')
    expect((await replacement.attach(handle, attachment)).status).toBe('open')
    expect(handle.snapshot().history.at(-1)!.events).toHaveLength(0)
  } finally {
    await service.dispose()
    await replacement.dispose()
    await transport.dispose()
    await directory.dispose()
    await repository.dispose()
  }
})

it('releases the Handle claim after an attachment rejects an ended Directory declaration', async () => {
  const repository = createRepository()
  const directory = createSessionDirectory()
  const transport = createInProcessMessageTransport(directory)
  const service = new CommunicationService({ directory, transport, limits })
  try {
    const handle = await repository.create()
    const external = await directory.declare(handle.header.address, 'ended')
    await expect(service.attach(handle, attachment)).rejects.toMatchObject({ code: 'MESSAGE_SESSION_ENDED' })
    expect(directory.status(handle.header.address).kind).toBe('ended')
    await external.dispose()
    expect((await service.attach(handle, attachment)).status).toBe('open')
  } finally {
    await service.dispose()
    await transport.dispose()
    await directory.dispose()
    await repository.dispose()
  }
})

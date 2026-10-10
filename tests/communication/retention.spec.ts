import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import {
  CommunicationService,
  allowAllCommunicationPolicy,
  createInProcessMessageTransport,
  createMessageCatalog,
  createSessionDirectory,
  formatSessionAddress,
  parseChannelId,
} from '../../src/index.js'
import { channelIds, createRepository, limits, requestMessage } from './fixtures.js'

async function releasedCommunication(keepSnapshot: boolean) {
  const repository = createRepository()
  const directory = createSessionDirectory()
  const transport = createInProcessMessageTransport(directory)
  const clock = { now: () => 1_789_257_600_000 }
  const catalog = createMessageCatalog([requestMessage])
  const service = new CommunicationService({ directory, transport, clock, limits })
  const handle = await repository.create()
  const target = await repository.create()
  const mailbox = await service.attach(handle, { catalog, policy: allowAllCommunicationPolicy })
  await mailbox.send(requestMessage, {
    kind: 'root', recipient: target.header.address, channelId: parseChannelId(channelIds[0]),
  }, { text: 'durable pending message' })
  const dispatcher = service.createDispatcher(mailbox)
  const snapshot = mailbox.snapshot()
  const refs = {
    service: new WeakRef(service), handle: new WeakRef(handle), repository: new WeakRef(repository),
    transport: new WeakRef(transport), directory: new WeakRef(directory), clock: new WeakRef(clock), catalog: new WeakRef(catalog),
  }
  await service.dispose()
  await transport.dispose()
  await directory.dispose()
  await repository.dispose()
  return { mailbox, dispatcher, refs, snapshot: keepSnapshot ? snapshot : undefined }
}

it.each([false, true])('retires Mailbox and Dispatcher resources with an independently retained Snapshot=%s', async keepSnapshot => {
  const { mailbox, dispatcher, refs, snapshot } = await releasedCommunication(keepSnapshot)
  await setImmediate()
  queryObjects(CommunicationService, { format: 'count' })
  expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined]))).toEqual({
    service: false, handle: false, repository: false, transport: false, directory: false, clock: false, catalog: false,
  })
  expect(mailbox.status).toBe('disposed')
  expect(mailbox.address).toBe(formatSessionAddress(mailbox.sessionId))
  expect(() => mailbox.snapshot()).toThrowError(expect.objectContaining({ code: 'MESSAGE_MAILBOX_INACTIVE' }))
  await expect(dispatcher.dispatch()).rejects.toMatchObject({ code: 'MESSAGE_MAILBOX_INACTIVE' })
  expect(mailbox.dispose()).toBe(mailbox.dispose())
  if (keepSnapshot) {
    expect(snapshot?.outbox[0]).toMatchObject({ status: 'pending', envelope: { payload: { text: 'durable pending message' } } })
    expect(Object.isFrozen(snapshot)).toBe(true)
  } else expect(snapshot).toBeUndefined()
})

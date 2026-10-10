import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import {
  FileSessionBackend,
  createMessageCatalog,
  createMessageDefinition,
  decodeMessagePayload,
  parseChannelId,
} from '../../src/index.js'
import type { JsonObject, MessageEnvelope } from '../../src/index.js'
import { channelIds, createCommunicationService, createRepository } from './fixtures.js'

interface Temperature extends JsonObject {
  readonly unit: 'fahrenheit'
  readonly value: number
}

function temperatureDefinition() {
  return createMessageDefinition<Temperature>({
    type: 'test/temperature', payloadVersion: 1,
    decode: value => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('temperature record')
      const record = value as JsonObject
      if (typeof record.value !== 'number' || record.unit !== 'celsius' && record.unit !== 'fahrenheit') {
        throw new TypeError('temperature unit and value')
      }
      return { unit: 'fahrenheit', value: record.unit === 'celsius' ? record.value * 9 / 5 + 32 : record.value }
    },
  })
}

it('delivers canonical payloads between independently created Message Definitions', async () => {
  const repository = createRepository()
  const runtime = createCommunicationService()
  try {
    const senderHandle = await repository.create(), recipientHandle = await repository.create()
    const sending = temperatureDefinition(), receiving = temperatureDefinition()
    const sender = await runtime.service.attach(senderHandle, { catalog: createMessageCatalog([sending]), policy: runtime.policy })
    const recipient = await runtime.service.attach(recipientHandle, { catalog: createMessageCatalog([receiving]), policy: runtime.policy })
    const accepted = await sender.send(sending, {
      kind: 'root', recipient: recipient.address, channelId: parseChannelId(channelIds[0]),
    }, { unit: 'celsius', value: 0 })
    expect(accepted.envelope.payload).toEqual({ unit: 'fahrenheit', value: 32 })
    expect(decodeMessagePayload(sending, accepted.envelope.payload)).toEqual(accepted.envelope.payload)
    expect(await runtime.service.createDispatcher(sender).dispatch()).toMatchObject({ delivered: 1 })
    expect(recipient.snapshot().inbox[0]?.envelope).toEqual(accepted.envelope)
    expect(decodeMessagePayload(receiving, recipient.snapshot().inbox[0]!.envelope.payload)).toEqual(accepted.envelope.payload)
  } finally {
    await runtime.service.dispose()
    await runtime.transport.dispose()
    await runtime.directory.dispose()
    await repository.dispose()
  }
})

it('replays canonical Inbox payloads with a fresh File object graph and Message Definition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-message-normalization-'))
  try {
    const initial = createRepository(new FileSessionBackend({ root, maxRecordBytes: 8192 }))
    const firstRuntime = createCommunicationService()
    const senderHandle = await initial.create(), recipientHandle = await initial.create()
    const definition = temperatureDefinition()
    const senderId = senderHandle.header.sessionId, recipientId = recipientHandle.header.sessionId
    let envelope: MessageEnvelope<Temperature>
    try {
      const catalog = createMessageCatalog([definition])
      const sender = await firstRuntime.service.attach(senderHandle, { catalog, policy: firstRuntime.policy })
      const recipient = await firstRuntime.service.attach(recipientHandle, { catalog, policy: firstRuntime.policy })
      envelope = (await sender.send(definition, {
        kind: 'root', recipient: recipient.address, channelId: parseChannelId(channelIds[0]),
      }, { unit: 'celsius', value: 100 })).envelope
      expect(await firstRuntime.service.createDispatcher(sender).dispatch()).toMatchObject({ delivered: 1 })
    } finally {
      await firstRuntime.service.dispose()
      await firstRuntime.transport.dispose()
      await firstRuntime.directory.dispose()
      await initial.dispose()
    }

    const reopened = createRepository(new FileSessionBackend({ root, maxRecordBytes: 8192 }))
    const secondRuntime = createCommunicationService()
    try {
      const freshDefinition = temperatureDefinition()
      const catalog = createMessageCatalog([freshDefinition])
      const sender = await secondRuntime.service.attach(await reopened.open(senderId), { catalog, policy: secondRuntime.policy })
      const recipient = await secondRuntime.service.attach(await reopened.open(recipientId), { catalog, policy: secondRuntime.policy })
      expect(sender.snapshot().outbox[0]).toMatchObject({ status: 'delivered', envelope })
      const incoming = recipient.snapshot().inbox[0]!
      expect(incoming).toMatchObject({ supported: true, envelope: { payload: { unit: 'fahrenheit', value: 212 } } })
      expect(incoming.envelope).toEqual(envelope)
      expect(decodeMessagePayload(freshDefinition, incoming.envelope.payload)).toEqual(incoming.envelope.payload)
      expect(await secondRuntime.service.createDispatcher(sender).dispatch()).toMatchObject({ startedAttempts: 0 })
      expect(recipient.snapshot().inbox).toHaveLength(1)
    } finally {
      await secondRuntime.service.dispose()
      await secondRuntime.transport.dispose()
      await secondRuntime.directory.dispose()
      await reopened.dispose()
    }
  } finally {
    expect(dirname(root)).toBe(tmpdir())
    await rm(root, { recursive: true, force: true })
  }
})

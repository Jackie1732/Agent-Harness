import { describe, expect, it } from 'vitest'
import {
  SessionContext,
  communicationSessionEventDefinitions,
  createDurableEventDefinition,
  createMessageCatalog,
  createMessageDefinition,
  decodeMessageEnvelope,
  formatSessionAddress,
  messageEnvelopeDigest,
  parseChannelId,
  parseMessageId,
  parseSessionId,
  projectCommunicationFacts,
  projectMailbox,
} from '../../src/index.js'
import { inboxAcceptedEvent, inboxProcessedEvent } from '../../src/communication/session-events.js'
import type { JsonObject, JsonValue, MessageDefinition } from '../../src/index.js'
import { profile, repository, scriptedModel, selection } from './fixtures.js'

interface TextPayload extends JsonObject { readonly text: string }

function textDefinition(type: string, decoded: () => void = () => undefined): MessageDefinition<TextPayload> {
  return createMessageDefinition({
    type,
    payloadVersion: 1,
    decode: (value: JsonValue) => {
      decoded()
      if (value === null || Array.isArray(value) || typeof value !== 'object') {
        throw new TypeError('text required')
      }
      const object = value as JsonObject
      if (typeof object.text !== 'string') throw new TypeError('text required')
      return { text: object.text }
    },
  })
}

function envelope(recipient: string, type: string, id: string, text: JsonValue) {
  const messageId = parseMessageId(id)
  return decodeMessageEnvelope({
    envelopeVersion: 1,
    messageId,
    sender: formatSessionAddress(parseSessionId('30000000-0000-4000-8000-000000000299')),
    recipient,
    channelId: parseChannelId('40000000-0000-4000-8000-000000000101'),
    channelSequence: 1,
    correlationId: messageId,
    createdAt: '2026-09-15T00:00:00.000Z',
    type,
    payloadVersion: 1,
    payload: text,
  })
}

describe('Context communication inputs', () => {
  it('decodes only an include-full pending message and never changes Inbox state', async () => {
    let currentDecodes = 0
    let historicalDecodes = 0
    const current = textDefinition('context/current', () => { currentDecodes += 1 })
    const historical = textDefinition('context/historical', () => {
      historicalDecodes += 1
      throw new Error('must not decode unselected history')
    })
    const catalog = createMessageCatalog([current, historical])
    const repo = repository(undefined, communicationSessionEventDefinitions)
    const provider = scriptedModel()
    try {
      const handle = await repo.create()
      const oldEnvelope = envelope(handle.header.address, historical.type, '50000000-0000-4000-8000-000000000101', { incompatible: true })
      await handle.append(inboxAcceptedEvent, { envelope: oldEnvelope, digest: messageEnvelopeDigest(oldEnvelope) })
      await handle.append(inboxProcessedEvent, { messageId: oldEnvelope.messageId })
      const pendingEnvelope = envelope(handle.header.address, current.type, '50000000-0000-4000-8000-000000000102', { text: 'peer payload' })
      await handle.append(inboxAcceptedEvent, { envelope: pendingEnvelope, digest: messageEnvelopeDigest(pendingEnvelope) })

      const context = new SessionContext({ session: handle, messageCatalog: catalog })
      const recordedProfile = await context.recordProfile(profile())
      const recordedInput = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'test', text: 'host input' })
      const assembled = await context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
        inbox: [{ messageId: pendingEnvelope.messageId, action: 'include-full' }],
      }))
      expect(assembled.kind).toBe('ready')
      if (assembled.kind !== 'ready') throw new Error('expected ready assembly')
      expect(currentDecodes).toBe(1)
      expect(historicalDecodes).toBe(0)
      expect(assembled.committed.payload.selected.map(item => item.reference.selector)).toContain('peer-message')
      expect(projectCommunicationFacts(handle.snapshot()).inbox).toMatchObject([
        { messageId: oldEnvelope.messageId, status: 'processed' },
        { messageId: pendingEnvelope.messageId, status: 'pending' },
      ])
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('publishes accepted work before a Message decoder can reenter or dispose the Context', async () => {
    let context: SessionContext
    let disposal: Promise<void> | undefined
    const definition = textDefinition('context/reentrant', () => {
      expect(() => context.recordInput({
        kind: 'user', origin: 'host-authored', originLabel: 'decoder', text: 'must not be accepted',
      })).toThrowError(expect.objectContaining({ code: 'CONTEXT_SESSION_BUSY' }))
      disposal = context.dispose()
    })
    const repo = repository(undefined, communicationSessionEventDefinitions)
    const provider = scriptedModel()
    try {
      const handle = await repo.create()
      const pending = envelope(handle.header.address, definition.type, '50000000-0000-4000-8000-000000000106', { text: 'peer payload' })
      await handle.append(inboxAcceptedEvent, { envelope: pending, digest: messageEnvelopeDigest(pending) })
      context = new SessionContext({ session: handle, messageCatalog: createMessageCatalog([definition]) })
      const recordedProfile = await context.recordProfile(profile())
      const recordedInput = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'test', text: 'host input' })
      const assembled = await context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
        inbox: [{ messageId: pending.messageId, action: 'include-full' }],
      }))
      expect(assembled.kind).toBe('ready')
      await disposal
      expect(context.status).toBe('disposed')
      expect(projectCommunicationFacts(handle.snapshot()).inbox[0]).toMatchObject({ status: 'pending' })
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('permits explicit defer without running the pending decoder', async () => {
    let decodes = 0
    const definition = textDefinition('context/deferred', () => { decodes += 1 })
    const repo = repository(undefined, communicationSessionEventDefinitions)
    const provider = scriptedModel()
    try {
      const handle = await repo.create()
      const pending = envelope(handle.header.address, definition.type, '50000000-0000-4000-8000-000000000103', { text: 'later' })
      await handle.append(inboxAcceptedEvent, { envelope: pending, digest: messageEnvelopeDigest(pending) })
      const context = new SessionContext({ session: handle, messageCatalog: createMessageCatalog([definition]) })
      const recordedProfile = await context.recordProfile(profile())
      const recordedInput = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'test', text: 'now' })
      const assembled = await context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
        inbox: [{ messageId: pending.messageId, action: 'defer' }],
      }))
      expect(assembled.kind).toBe('ready')
      if (assembled.kind !== 'ready') throw new Error('expected ready assembly')
      expect(decodes).toBe(0)
      expect(assembled.committed.payload.deferred).toMatchObject([{ messageId: pending.messageId, status: 'pending' }])
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('blocks include-full when no current decoder exists and keeps facts replayable', async () => {
    const repo = repository(undefined, communicationSessionEventDefinitions)
    const provider = scriptedModel()
    try {
      const handle = await repo.create()
      const pending = envelope(handle.header.address, 'context/uninstalled', '50000000-0000-4000-8000-000000000104', { text: 'unknown' })
      await handle.append(inboxAcceptedEvent, { envelope: pending, digest: messageEnvelopeDigest(pending) })
      const context = new SessionContext({ session: handle, messageCatalog: createMessageCatalog() })
      const recordedProfile = await context.recordProfile(profile())
      const recordedInput = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'test', text: 'host' })
      const before = handle.snapshot().localPosition
      await expect(context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
        inbox: [{ messageId: pending.messageId, action: 'include-full' }],
      }))).resolves.toMatchObject({ kind: 'blocked', reason: 'unsupported-message' })
      expect(handle.snapshot().localPosition).toBe(before)
      expect(projectCommunicationFacts(handle.snapshot()).inbox[0]).toMatchObject({ status: 'pending' })
      expect(projectMailbox(handle.snapshot(), createMessageCatalog()).unsupportedInbox).toEqual([pending.messageId])
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('preserves a terminal Inbox fact after its Definition is unloaded and rejects a currently incompatible decoder', async () => {
    const repo = repository(undefined, communicationSessionEventDefinitions)
    try {
      const handle = await repo.create()
      const accepted = envelope(handle.header.address, 'context/historical-terminal', '50000000-0000-4000-8000-000000000105', { text: 'past payload' })
      await handle.append(inboxAcceptedEvent, { envelope: accepted, digest: messageEnvelopeDigest(accepted) })
      await handle.append(inboxProcessedEvent, { messageId: accepted.messageId })

      expect(projectCommunicationFacts(handle.snapshot()).inbox[0]).toMatchObject({
        messageId: accepted.messageId,
        status: 'processed',
      })
      expect(projectMailbox(handle.snapshot(), createMessageCatalog()).inbox[0]).toMatchObject({
        messageId: accepted.messageId,
        status: 'processed',
        supported: false,
      })
      const incompatible = textDefinition('context/historical-terminal', () => {
        throw new Error('installed schema no longer accepts the payload')
      })
      expect(() => projectMailbox(handle.snapshot(), createMessageCatalog([incompatible]))).toThrowError(
        expect.objectContaining({ code: 'MESSAGE_STATE_INVALID' }),
      )
    } finally {
      await repo.dispose()
    }
  })

  it('retains an unknown ignorable Communication extension without treating it as mailbox state', async () => {
    const extension = createDurableEventDefinition({
      type: 'communication/example-extension', payloadVersion: 1, ignorable: true,
      decode: value => value,
    })
    const repo = repository(undefined, [...communicationSessionEventDefinitions, extension])
    try {
      const handle = await repo.create()
      await handle.append(extension, { retained: true })
      expect(projectCommunicationFacts(handle.snapshot())).toMatchObject({ outbox: [], inbox: [] })
    } finally {
      await repo.dispose()
    }
  })
})

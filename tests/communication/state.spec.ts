import { describe, expect, it } from 'vitest'
import {
  CommunicationService,
  MemorySessionBackend,
  SessionRepository,
  createDurableEventCatalog,
  createInProcessMessageTransport,
  createMessageCatalog,
  createSessionDirectory,
  decodeMessageEnvelope,
  formatSessionAddress,
  formatSessionEventId,
  messageEnvelopeDigest,
  parseChannelId,
  parseMessageId,
  parseSessionAddress,
  parseSessionId,
  projectMailbox,
  sessionSequence,
} from '../../src/index.js'
import type { MessageTransport } from '../../src/index.js'
import {
  inboxAcceptedEvent,
  outboxAcceptedEvent,
  outboxAbandonedEvent,
  outboxAttemptFailedEvent,
  outboxAttemptStartedEvent,
  outboxDeliveredEvent,
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
} from './fixtures.js'

const firstSession = parseSessionId('00000000-0000-4000-8000-000000000151')
const secondSession = parseSessionId('00000000-0000-4000-8000-000000000152')
const messageId = parseMessageId('10000000-0000-4000-8000-000000000151')

function envelope(type = requestMessage.type) {
  return decodeMessageEnvelope({
    envelopeVersion: 1,
    messageId,
    sender: formatSessionAddress(firstSession),
    recipient: formatSessionAddress(secondSession),
    channelId: parseChannelId(channelIds[0]),
    channelSequence: 1,
    correlationId: messageId,
    createdAt: '2026-09-13T00:00:00.000Z',
    type,
    payloadVersion: 1,
    payload: { text: 'state' },
  })
}

function ambiguousCommitBackend(eventType: string) {
  return loseFirstCommitAcknowledgement(new MemorySessionBackend({ maxRecordBytes: 8192 }), eventType)
}

describe('communication state validation', () => {
  it('maps an invalid recipient to the communication error vocabulary before committing', async () => {
    const repository = createRepository()
    const runtime = createCommunicationService()
    try {
      const handle = await repository.create()
      const mailbox = await runtime.service.attach(handle, { catalog: messageCatalog, policy: runtime.policy })

      await expect(mailbox.send(requestMessage, {
        kind: 'root', recipient: 'not-a-session-address' as never, channelId: parseChannelId(channelIds[0]),
      }, { text: 'invalid recipient' })).rejects.toMatchObject({ code: 'MESSAGE_ENVELOPE_INVALID' })
      expect(mailbox.snapshot().outbox).toHaveLength(0)
    } finally {
      await runtime.service.dispose()
      await runtime.transport.dispose()
      await runtime.directory.dispose()
      await repository.dispose()
    }
  })

  it('preserves an Inbox record when its Message Definition is unavailable', async () => {
    const repository = createRepository(undefined, sessionIdentities([secondSession]))
    try {
      const handle = await repository.create()
      const unknown = envelope('test/uninstalled')
      await handle.append(inboxAcceptedEvent, { envelope: unknown, digest: messageEnvelopeDigest(unknown) })

      const snapshot = projectMailbox(handle.snapshot(), createMessageCatalog())
      expect(snapshot.inbox[0]).toMatchObject({ status: 'pending', supported: false })
      expect(snapshot.unsupportedInbox).toEqual([messageId])
    } finally {
      await repository.dispose()
    }
  })

  it('rejects a durable Outbox whose sender does not own the Session', async () => {
    const repository = createRepository(undefined, sessionIdentities([secondSession]))
    try {
      const handle = await repository.create()
      await handle.append(outboxAcceptedEvent, { envelope: envelope() })
      expect(() => projectMailbox(handle.snapshot(), messageCatalog)).toThrowError(
        expect.objectContaining({ code: 'MESSAGE_STATE_INVALID' }),
      )
    } finally {
      await repository.dispose()
    }
  })

  it('rejects an Outbox abandonment that skips an open attempt result', async () => {
    const repository = createRepository(undefined, sessionIdentities([firstSession]))
    try {
      const handle = await repository.create()
      const accepted = envelope()
      await handle.append(outboxAcceptedEvent, { envelope: accepted })
      await handle.append(outboxAttemptStartedEvent, { messageId: accepted.messageId, attempt: 1 })
      await handle.append(outboxAbandonedEvent, { messageId: accepted.messageId, reason: 'caller-requested' })

      expect(() => projectMailbox(handle.snapshot(), messageCatalog)).toThrowError(
        expect.objectContaining({ code: 'MESSAGE_STATE_INVALID' }),
      )
    } finally {
      await repository.dispose()
    }
  })

  it('fails attachment before writes when the Session Catalog lacks communication events', async () => {
    const repository = new SessionRepository({
      backend: new MemorySessionBackend({ maxRecordBytes: 8192 }),
      catalog: createDurableEventCatalog(),
      maxLineageDepth: 1,
      identitySource: sessionIdentities(),
    })
    const directory = createSessionDirectory()
    const transport = createInProcessMessageTransport(directory)
    const service = new CommunicationService({ directory, transport, limits })
    try {
      const handle = await repository.create()
      await expect(service.attach(handle, { catalog: messageCatalog, policy: {
        canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }),
      } })).rejects.toMatchObject({ code: 'MESSAGE_SESSION_CATALOG_INCOMPATIBLE' })
    } finally {
      await service.dispose()
      await transport.dispose()
      await directory.dispose()
      await repository.dispose()
    }
  })

  it('distinguishes unknown, known-offline, online, and ended addresses', async () => {
    const repository = createRepository()
    const runtime = createCommunicationService()
    try {
      const handle = await repository.create()
      expect(runtime.directory.status(handle.header.address).kind).toBe('unknown')
      const declaration = await runtime.directory.declare(handle.header.address, 'active')
      expect(runtime.directory.status(handle.header.address).kind).toBe('known-offline')
      const mailbox = await runtime.service.attach(handle, { catalog: messageCatalog, policy: runtime.policy })
      expect(runtime.directory.status(handle.header.address).kind).toBe('online')
      await mailbox.endSession()
      expect(runtime.directory.status(handle.header.address).kind).toBe('ended')
      await declaration.dispose()
    } finally {
      await runtime.service.dispose()
      await runtime.transport.dispose()
      await runtime.directory.dispose()
      await repository.dispose()
    }
  })

  it('turns a retry budget exhaustion into local abandonment', async () => {
    const repository = createRepository()
    const runtime = createCommunicationService({ maxDeliveryAttempts: 2, maxAttemptsPerRun: 1 })
    try {
      const handle = await repository.create()
      const mailbox = await runtime.service.attach(handle, { catalog: messageCatalog, policy: runtime.policy })
      const offline = formatSessionAddress(parseSessionId('00000000-0000-4000-8000-000000000159'))
      const declaration = await runtime.directory.declare(offline, 'active')
      const outgoing = await mailbox.send(requestMessage, {
        kind: 'root', recipient: offline, channelId: parseChannelId(channelIds[0]),
      }, { text: 'bounded' })
      const dispatcher = runtime.service.createDispatcher(mailbox)

      expect(await dispatcher.dispatch()).toMatchObject({ retryable: 1, remainingPending: 1 })
      expect(await dispatcher.dispatch()).toMatchObject({ abandoned: 1, remainingPending: 0 })
      expect(mailbox.snapshot().outbox[0]).toMatchObject({
        messageId: outgoing.messageId, status: 'abandoned', abandonReason: 'attempts-exhausted', attemptCount: 2,
      })
      await declaration.dispose()
    } finally {
      await runtime.service.dispose()
      await runtime.transport.dispose()
      await runtime.directory.dispose()
      await repository.dispose()
    }
  })

  it('rejects Transport calls that have no active persisted sender attempt', async () => {
    const directory = createSessionDirectory()
    const transport = createInProcessMessageTransport(directory)
    try {
      await expect(transport.deliver(envelope(), { signal: new AbortController().signal })).rejects.toMatchObject({
        code: 'MESSAGE_TRANSPORT_SOURCE_INVALID',
      })
    } finally {
      await transport.dispose()
      await directory.dispose()
    }
  })

  it('records an unrelated provider receipt as an unknown retry outcome', async () => {
    const repository = createRepository()
    const directory = createSessionDirectory()
    let delivery = 0
    const transport: MessageTransport = {
      async deliver(candidate) {
        delivery += 1
        return {
          kind: 'accepted',
          receipt: {
            messageId: delivery === 1
              ? parseMessageId('10000000-0000-4000-8000-000000000199')
              : candidate.messageId,
            recipient: candidate.recipient,
            inboxEventId: formatSessionEventId(
              delivery === 1 ? parseSessionAddress(candidate.recipient) : secondSession,
              sessionSequence(1),
            ),
          },
        }
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
      }, { text: 'wrong message receipt' })
      await sender.send(requestMessage, {
        kind: 'root', recipient: recipientHandle.header.address, channelId: parseChannelId(channelIds[1]),
      }, { text: 'wrong recipient event receipt' })

      await expect(service.createDispatcher(sender).dispatch()).resolves.toMatchObject({
        delivered: 0, retryable: 2, remainingPending: 2,
      })
      expect(sender.snapshot().outbox.map(item => ({
        status: item.status,
        attempt: item.lastFailure?.attempt,
        failure: item.lastFailure?.code,
      }))).toEqual([
        { status: 'pending', attempt: 1, failure: 'transport-outcome-unknown' },
        { status: 'pending', attempt: 1, failure: 'transport-outcome-unknown' },
      ])
    } finally {
      await service.dispose()
      await directory.dispose()
      await repository.dispose()
    }
  })

  it('surfaces a recipient policy configuration failure after settling the sender attempt', async () => {
    const repository = createRepository()
    const runtime = createCommunicationService()
    try {
      const senderHandle = await repository.create()
      const recipientHandle = await repository.create()
      const sender = await runtime.service.attach(senderHandle, { catalog: messageCatalog, policy: runtime.policy })
      const recipient = await runtime.service.attach(recipientHandle, {
        catalog: messageCatalog,
        policy: {
          canSend: () => ({ kind: 'allow' }),
          canReceive: () => ({ kind: 'invalid' }) as never,
        },
      })
      await sender.send(requestMessage, {
        kind: 'root', recipient: recipient.address, channelId: parseChannelId(channelIds[0]),
      }, { text: 'bad receiver policy' })

      await expect(runtime.service.createDispatcher(sender).dispatch()).rejects.toMatchObject({
        code: 'MESSAGE_CONFIG_INVALID',
      })
      expect(sender.snapshot().outbox[0]).toMatchObject({
        status: 'pending',
        lastFailure: { attempt: 1, code: 'transport-outcome-unknown' },
      })
      expect(recipient.snapshot().inbox).toHaveLength(0)
    } finally {
      await runtime.service.dispose()
      await runtime.transport.dispose()
      await runtime.directory.dispose()
      await repository.dispose()
    }
  })

  it('detects pending communication after a caller bypasses Mailbox endSession', async () => {
    const repository = createRepository()
    const firstRuntime = createCommunicationService()
    const handle = await repository.create()
    const mailbox = await firstRuntime.service.attach(handle, { catalog: messageCatalog, policy: firstRuntime.policy })
    await mailbox.send(requestMessage, {
      kind: 'root',
      recipient: formatSessionAddress(parseSessionId('00000000-0000-4000-8000-000000000158')),
      channelId: parseChannelId(channelIds[0]),
    }, { text: 'stranded' })
    await handle.end('bypassed mailbox')
    await firstRuntime.service.dispose()
    await firstRuntime.transport.dispose()
    await firstRuntime.directory.dispose()

    const secondRuntime = createCommunicationService()
    try {
      await expect(secondRuntime.service.attach(handle, {
        catalog: messageCatalog,
        policy: secondRuntime.policy,
      })).rejects.toMatchObject({ code: 'MESSAGE_STATE_INVALID' })
    } finally {
      await secondRuntime.service.dispose()
      await secondRuntime.transport.dispose()
      await secondRuntime.directory.dispose()
      await repository.dispose()
    }
  })

  it('faults on an ambiguous Outbox commit and lets a fresh Handle recover the fact', async () => {
    const repository = createRepository(ambiguousCommitBackend(outboxAcceptedEvent.type))
    const runtime = createCommunicationService()
    try {
      const handle = await repository.create()
      const mailbox = await runtime.service.attach(handle, { catalog: messageCatalog, policy: runtime.policy })
      await expect(mailbox.send(requestMessage, {
        kind: 'root',
        recipient: formatSessionAddress(parseSessionId('00000000-0000-4000-8000-000000000157')),
        channelId: parseChannelId(channelIds[0]),
      }, { text: 'uncertain' })).rejects.toMatchObject({ code: 'MESSAGE_OUTBOX_COMMIT_UNKNOWN' })
      expect(mailbox.status).toBe('faulted')

      await runtime.service.dispose()
      await handle.dispose()
      const reopened = await repository.open(handle.header.sessionId)
      expect(projectMailbox(reopened.snapshot(), messageCatalog).outbox).toHaveLength(1)
    } finally {
      await runtime.service.dispose()
      await runtime.transport.dispose()
      await runtime.directory.dispose()
      await repository.dispose()
    }
  })

  it('recovers a delivered terminal state after its sender acknowledgement is lost', async () => {
    const repository = createRepository(ambiguousCommitBackend(outboxDeliveredEvent.type))
    const runtime = createCommunicationService()
    const senderHandle = await repository.create()
    const recipientHandle = await repository.create()
    const senderId = senderHandle.header.sessionId
    try {
      const sender = await runtime.service.attach(senderHandle, { catalog: messageCatalog, policy: runtime.policy })
      const recipient = await runtime.service.attach(recipientHandle, { catalog: messageCatalog, policy: runtime.policy })
      await sender.send(requestMessage, {
        kind: 'root', recipient: recipient.address, channelId: parseChannelId(channelIds[0]),
      }, { text: 'delivered despite lost write acknowledgement' })

      await expect(runtime.service.createDispatcher(sender).dispatch()).rejects.toMatchObject({
        code: 'MESSAGE_OUTBOX_STATUS_COMMIT_UNKNOWN',
      })
      expect(sender.status).toBe('faulted')
      expect(recipient.snapshot().inbox).toHaveLength(1)

      await runtime.service.dispose()
      await senderHandle.dispose()
      await recipientHandle.dispose()
      const reopened = await repository.open(senderId)
      expect(projectMailbox(reopened.snapshot(), messageCatalog).outbox[0]?.status).toBe('delivered')
    } finally {
      await runtime.service.dispose()
      await runtime.transport.dispose()
      await runtime.directory.dispose()
      await repository.dispose()
    }
  })

  it.each([
    {
      label: 'attempt failure',
      eventType: outboxAttemptFailedEvent.type,
      recoveredStatus: 'pending',
    },
    {
      label: 'attempt exhaustion abandonment',
      eventType: outboxAbandonedEvent.type,
      recoveredStatus: 'abandoned',
    },
  ])('recovers an ambiguous final $label without reusing its attempt', async ({ eventType, recoveredStatus }) => {
    const repository = createRepository(ambiguousCommitBackend(eventType))
    const firstRuntime = createCommunicationService({ maxDeliveryAttempts: 1 })
    const senderHandle = await repository.create()
    const senderId = senderHandle.header.sessionId
    const offline = formatSessionAddress(parseSessionId('00000000-0000-4000-8000-000000000160'))
    const declaration = await firstRuntime.directory.declare(offline, 'active')
    try {
      const sender = await firstRuntime.service.attach(senderHandle, { catalog: messageCatalog, policy: firstRuntime.policy })
      const outgoing = await sender.send(requestMessage, {
        kind: 'root', recipient: offline, channelId: parseChannelId(channelIds[0]),
      }, { text: `ambiguous ${eventType}` })

      await expect(firstRuntime.service.createDispatcher(sender).dispatch()).rejects.toMatchObject({
        code: 'MESSAGE_OUTBOX_STATUS_COMMIT_UNKNOWN',
      })
      expect(sender.status).toBe('faulted')

      await firstRuntime.service.dispose()
      await declaration.dispose()
      await firstRuntime.transport.dispose()
      await firstRuntime.directory.dispose()
      await senderHandle.dispose()

      const secondRuntime = createCommunicationService({ maxDeliveryAttempts: 1 })
      try {
        const reopenedHandle = await repository.open(senderId)
        const reopened = await secondRuntime.service.attach(reopenedHandle, {
          catalog: messageCatalog,
          policy: secondRuntime.policy,
        })
        expect(reopened.snapshot().outbox[0]).toMatchObject({
          messageId: outgoing.messageId,
          status: recoveredStatus,
          attemptCount: 1,
        })
        expect(await secondRuntime.service.createDispatcher(reopened).dispatch()).toMatchObject({
          startedAttempts: 0,
          abandoned: recoveredStatus === 'pending' ? 1 : 0,
          remainingPending: 0,
        })
        expect(reopened.snapshot().outbox[0]).toMatchObject({ status: 'abandoned', attemptCount: 1 })
        expect(reopenedHandle.snapshot().history.at(-1)?.events
          .filter(event => event.stored.type === outboxAttemptStartedEvent.type)).toHaveLength(1)
        await secondRuntime.service.dispose()
        await reopenedHandle.dispose()
      } finally {
        await secondRuntime.service.dispose()
        await secondRuntime.transport.dispose()
        await secondRuntime.directory.dispose()
      }
    } finally {
      await firstRuntime.service.dispose()
      await declaration.dispose()
      await firstRuntime.transport.dispose()
      await firstRuntime.directory.dispose()
      await repository.dispose()
    }
  })
})

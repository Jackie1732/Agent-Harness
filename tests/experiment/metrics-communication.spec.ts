import { describe, expect, it } from 'vitest'
import { collectExperimentMetrics } from '../../src/experiment/metrics.js'
import type { MetricsInput } from '../../src/experiment/metrics-types.js'
import type { SessionSnapshot } from '../../src/session/types.js'
import { formatSessionAddress, parseSessionId } from '../../src/session/ids.js'
import { inboxAcceptedEvent, outboxAcceptedEvent } from '../../src/communication/session-events.js'
import { channelSequence, parseChannelId, parseMessageId } from '../../src/communication/ids.js'
import { messageEnvelopeDigest } from '../../src/communication/canonical-json.js'
import type { MessageEnvelope } from '../../src/communication/types.js'
import { SessionAgent } from '../../src/agent/session-agent.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { agentFixture, clock, observedAt } from '../agent/fixtures.js'
import { runnerLimits } from '../context/fixtures.js'
import { channelIds, createCommunicationService, createRepository, messageCatalog, messageIds, replyMessage, requestMessage, sessionIds } from '../communication/fixtures.js'

function input(snapshots: readonly SessionSnapshot[], overrides: Partial<MetricsInput> = {}): MetricsInput {
  return { snapshots, selectedSessionIds: snapshots.map(snapshot => snapshot.header.sessionId), scope: 'unit-local/v1', mode: 'fixture',
    maxMetricSamples: 128, coverage: { complete: true, expectedSessions: snapshots.length, observedSessions: snapshots.length, reasons: [] }, ...overrides }
}

describe('experiment communication metrics', () => {
  it('counts sender and receiver facts separately while merging the two copies into one causal message', async () => {
    const repo = createRepository(), runtime = createCommunicationService()
    try {
      const senderSession = await repo.create(), recipientSession = await repo.create()
      const sender = await runtime.service.attach(senderSession, { catalog: messageCatalog, policy: runtime.policy })
      const recipient = await runtime.service.attach(recipientSession, { catalog: messageCatalog, policy: runtime.policy })
      const sent = await sender.send(requestMessage, { kind: 'root', recipient: recipient.address, channelId: parseChannelId(channelIds[0]) }, { text: 'question' })
      await runtime.service.createDispatcher(sender).dispatch()
      await recipient.markProcessed(sent.messageId)
      await recipient.reply(sent.messageId, replyMessage, { text: 'answer' })
      await runtime.service.createDispatcher(recipient).dispatch()
      const metrics = collectExperimentMetrics(input([senderSession.snapshot(), recipientSession.snapshot()]))
      expect(metrics.counts['communication.outboxAccepted'].value).toBe(2)
      expect(metrics.counts['communication.inboxAccepted'].value).toBe(2)
      expect(metrics.counts['communication.delivered'].value).toBe(2)
      expect(metrics.counts['communication.inboxProcessed'].value).toBe(1)
      expect(metrics.counts['communication.attemptStarted'].value).toBe(2)
      expect(metrics.counts['communication.modelMessageAdoptions'].value).toBe(0)
      expect(metrics.messageCausation).toMatchObject({ value: 1, uniqueMessages: 2, resolvedMessages: 2, status: 'complete', reasons: [] })
    } finally { await runtime.service.dispose(); await runtime.transport.dispose(); await runtime.directory.dispose(); await repo.dispose() }
  })

  it('records retry attempts on one durable Outbox identity without inventing new business messages', async () => {
    const repo = createRepository(), runtime = createCommunicationService()
    try {
      const senderSession = await repo.create(), recipientSession = await repo.create()
      const offline = await runtime.directory.declare(recipientSession.header.address, 'active')
      const sender = await runtime.service.attach(senderSession, { catalog: messageCatalog, policy: runtime.policy })
      await sender.send(requestMessage, { kind: 'root', recipient: recipientSession.header.address, channelId: parseChannelId(channelIds[0]) }, { text: 'later' })
      await runtime.service.createDispatcher(sender).dispatch()
      await offline.dispose()
      await runtime.service.attach(recipientSession, { catalog: messageCatalog, policy: runtime.policy })
      await runtime.service.createDispatcher(sender).dispatch()
      const metrics = collectExperimentMetrics(input([senderSession.snapshot(), recipientSession.snapshot()]))
      expect(metrics.counts['communication.outboxAccepted'].value).toBe(1)
      expect(metrics.counts['communication.attemptStarted'].value).toBe(2)
      expect(metrics.counts['communication.retries'].value).toBe(1)
      expect(metrics.counts['communication.attemptFailed.recipient-offline'].value).toBe(1)
      expect(metrics.counts['communication.delivered'].value).toBe(1)
    } finally { await runtime.service.dispose(); await runtime.transport.dispose(); await runtime.directory.dispose(); await repo.dispose() }
  })

  it('withholds a maximum when explicitly selected history omits a causal parent', async () => {
    const repo = createRepository()
    try {
      const session = await repo.create(), envelope: MessageEnvelope = { envelopeVersion: 1, messageId: parseMessageId(messageIds[1]),
        sender: formatSessionAddress(parseSessionId(sessionIds[1])), recipient: session.header.address, channelId: parseChannelId(channelIds[0]), channelSequence: channelSequence(1),
        correlationId: parseMessageId(messageIds[0]), causationId: parseMessageId(messageIds[0]), replyTo: parseMessageId(messageIds[0]),
        createdAt: observedAt, type: 'test/reply', payloadVersion: 1, payload: { text: 'parent outside selection' } }
      await session.append(inboxAcceptedEvent, { envelope, digest: messageEnvelopeDigest(envelope) })
      const metrics = collectExperimentMetrics(input([session.snapshot()]))
      expect(metrics.counts['communication.inboxAccepted'].value).toBe(1)
      expect(metrics.messageCausation).toMatchObject({ value: null, uniqueMessages: 1, resolvedMessages: 0, status: 'incomplete', reasons: ['missing-causation-parent'] })
    } finally { await repo.dispose() }
  })

  it('detects cross-log copy conflicts instead of choosing an arbitrary Envelope for a complete depth', async () => {
    const repo = createRepository()
    try {
      const sender = await repo.create(), recipient = await repo.create(), envelope: MessageEnvelope = { envelopeVersion: 1, messageId: parseMessageId(messageIds[0]),
        sender: sender.header.address, recipient: recipient.header.address, channelId: parseChannelId(channelIds[0]), channelSequence: channelSequence(1),
        correlationId: parseMessageId(messageIds[0]), createdAt: observedAt, type: 'test/request', payloadVersion: 1, payload: { text: 'sender version' } }
      await sender.append(outboxAcceptedEvent, { envelope })
      const conflicting = { ...envelope, payload: { text: 'receiver version' } }
      await recipient.append(inboxAcceptedEvent, { envelope: conflicting, digest: messageEnvelopeDigest(conflicting) })
      const metrics = collectExperimentMetrics(input([sender.snapshot(), recipient.snapshot()]))
      expect(metrics.messageCausation).toMatchObject({ value: null, uniqueMessages: 1, resolvedMessages: 0, reasons: ['message-content-conflict'], status: 'incomplete' })
    } finally { await repo.dispose() }
  })

  it('detects cycles through explicit causes and gives no empty-graph maximum', async () => {
    const repo = createRepository()
    try {
      const session = await repo.create()
      expect(collectExperimentMetrics(input([session.snapshot()])).messageCausation).toMatchObject({ value: null, uniqueMessages: 0, resolvedMessages: 0, status: 'complete' })
      for (const index of [0, 1] as const) {
        const envelope: MessageEnvelope = { envelopeVersion: 1, messageId: parseMessageId(messageIds[index]),
          sender: formatSessionAddress(parseSessionId(sessionIds[1])), recipient: session.header.address, channelId: parseChannelId(channelIds[0]), channelSequence: channelSequence(index + 1),
          correlationId: parseMessageId(messageIds[0]), causationId: parseMessageId(messageIds[1 - index]!), createdAt: observedAt, type: 'test/request', payloadVersion: 1, payload: { text: 'cycle' } }
        await session.append(inboxAcceptedEvent, { envelope, digest: messageEnvelopeDigest(envelope) })
      }
      expect(collectExperimentMetrics(input([session.snapshot()])).messageCausation).toMatchObject({ value: null, resolvedMessages: 0, uniqueMessages: 2, status: 'incomplete', reasons: ['causation-cycle'] })
    } finally { await repo.dispose() }
  })

  it('requires a claimed input and a real adopted Context to count content entering a model', async () => {
    const f = await agentFixture({ messages: [{ type: 'test/request', payloadVersion: 1, requiresReply: false }] }, undefined, messageCatalog)
    const runtime = createCommunicationService(), senderSession = await f.repo.create()
    const sender = await runtime.service.attach(senderSession, { catalog: messageCatalog, policy: runtime.policy })
    const recipient = await runtime.service.attach(f.session, { catalog: messageCatalog, policy: runtime.policy })
    const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
    const agent = new SessionAgent({ session: f.session, model, context: f.context, mailbox: recipient,
      dispatcher: runtime.service.createDispatcher(recipient), messageCatalog, clock })
    try {
      const first = await sender.send(requestMessage, { kind: 'root', recipient: recipient.address, channelId: parseChannelId(channelIds[0]) }, { text: 'discarded before claim' })
      await runtime.service.createDispatcher(sender).dispatch()
      await recipient.markProcessed(first.messageId)
      const processed = collectExperimentMetrics(input([f.session.snapshot(), senderSession.snapshot()]))
      expect(processed.counts['communication.inboxProcessed'].value).toBe(1)
      expect(processed.counts['communication.peerInputsClaimed'].value).toBe(0)
      expect(processed.counts['communication.modelMessageAdoptions'].value).toBe(0)
      await sender.send(requestMessage, { kind: 'root', recipient: recipient.address, channelId: parseChannelId(channelIds[0]) }, { text: 'use this content' })
      await runtime.service.createDispatcher(sender).dispatch()
      await agent.start()
      const adopted = collectExperimentMetrics(input([f.session.snapshot(), senderSession.snapshot()]))
      expect(adopted.counts['communication.inboxProcessed'].value).toBe(2)
      expect(adopted.counts['communication.peerInputsClaimed'].value).toBe(1)
      expect(adopted.counts['communication.modelMessageAdoptions'].value).toBe(1)
      expect(adopted.counts['agent.rootsCompleted'].value).toBe(1)
    } finally { await agent.dispose(); await runtime.service.dispose(); await runtime.transport.dispose(); await runtime.directory.dispose(); await f.close() }
  })
})

import { describe, expect, it } from 'vitest'
import {
  parseChannelId,
  projectCommunicationFacts,
} from '../../src/index.js'
import {
  outboxAbandonedEvent,
  outboxAttemptStartedEvent,
} from '../../src/communication/session-events.js'
import {
  channelIds,
  createCommunicationService,
  createRepository,
  messageCatalog,
  requestMessage,
} from './fixtures.js'

async function fixture() {
  const repository = createRepository()
  const runtime = createCommunicationService()
  const sender = await repository.create()
  const recipient = await repository.create()
  const otherRecipient = await repository.create()
  const mailbox = await runtime.service.attach(sender, { catalog: messageCatalog, policy: runtime.policy })
  const first = await mailbox.send(requestMessage, {
    kind: 'root', recipient: recipient.header.address, channelId: parseChannelId(channelIds[0]),
  }, { text: 'channel head' })
  const second = await mailbox.send(requestMessage, {
    kind: 'root', recipient: recipient.header.address, channelId: parseChannelId(channelIds[0]),
  }, { text: 'later message' })
  return {
    sender, recipient, otherRecipient, mailbox, first, second,
    dispose: async () => {
      await runtime.service.dispose()
      await runtime.transport.dispose()
      await runtime.directory.dispose()
      await repository.dispose()
    },
  }
}

describe('communication projection Channel order', () => {
  it('rejects a later persisted attempt while its Channel head remains pending', async () => {
    const f = await fixture()
    try {
      await f.sender.append(outboxAttemptStartedEvent, { messageId: f.second.messageId, attempt: 1 })
      expect(() => projectCommunicationFacts(f.sender.snapshot())).toThrowError(
        expect.objectContaining({ code: 'MESSAGE_STATE_INVALID' }),
      )
    } finally { await f.dispose() }
  })

  it.each(['other channel', 'other recipient'] as const)('allows an attempt for an independent %s', async kind => {
    const f = await fixture()
    try {
      const other = await f.mailbox.send(requestMessage, {
        kind: 'root',
        recipient: kind === 'other recipient' ? f.otherRecipient.header.address : f.recipient.header.address,
        channelId: parseChannelId(channelIds[kind === 'other channel' ? 1 : 0]),
      }, { text: 'independent channel head' })
      await f.sender.append(outboxAttemptStartedEvent, { messageId: other.messageId, attempt: 1 })
      expect(projectCommunicationFacts(f.sender.snapshot()).outbox.map(item => item.openAttempt)).toEqual([undefined, undefined, 1])
    } finally { await f.dispose() }
  })

  it('allows the next message after its Channel head becomes terminal', async () => {
    const f = await fixture()
    try {
      await f.sender.append(outboxAbandonedEvent, { messageId: f.first.messageId, reason: 'caller-requested' })
      await f.sender.append(outboxAttemptStartedEvent, { messageId: f.second.messageId, attempt: 1 })
      expect(projectCommunicationFacts(f.sender.snapshot()).outbox.map(item => ({ status: item.status, attempt: item.openAttempt })))
        .toEqual([{ status: 'abandoned', attempt: undefined }, { status: 'pending', attempt: 1 }])
    } finally { await f.dispose() }
  })
})

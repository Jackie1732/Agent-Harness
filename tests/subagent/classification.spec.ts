import { expect, it } from 'vitest'
import { inboxProcessedEvent } from '../../src/communication/session-events.js'
import * as events from '../../src/subagent/session-events.js'
import { rebuildAssembly } from '../../src/context/projection.js'
import { childFixture } from './child-fixture.js'

it('settles the protocol Inbox independently and claims one child root with the original deadline and reserved messages', async () => {
  const f = await childFixture()
  try {
    await expect(f.journal.append(inboxProcessedEvent, () => ({ messageId: f.envelope.messageId }))).rejects.toThrow('protocol-receipt-before-classification')
    const classified = await f.journal.append(events.subagentMessageClassifiedEvent, () => ({ ...f.id, inbox: f.inbox!.stored.eventId,
      kind: 'task' as const, classification: 'eligible' as const, reasonCode: 'authorized-task' }))
    await f.journal.append(inboxProcessedEvent, () => ({ messageId: f.envelope.messageId }))
    expect(f.agent.snapshot().inputs).toMatchObject([{ reference: { kind: 'subagent', eventId: classified.stored.eventId }, status: 'queued' }])
    const report = await f.agent.start()
    expect(report.roots).toMatchObject([{ outcome: 'completed', deadline: f.parent.requested.deadline }])
    expect(f.agent.snapshot().roots[0]?.budget).toMatchObject({ messages: 4, models: 1, steps: 1, outputTokens: 256 })
    expect(f.agent.snapshot().turns[0]?.started.payload.protocolSource).toBe(f.inbox!.stored.eventId)
    for (const event of f.session.snapshot().history.at(-1)!.events.filter(item => item.stored.type === 'context/assembly-committed')) {
      expect(rebuildAssembly(f.session.snapshot(), event.stored.eventId).kind).toBe('rebuilt')
    }
    await f.agent.start()
    expect(f.agent.snapshot().roots).toHaveLength(1)
  } finally { await f.close() }
})

it('abandons a classified input using control v3 without reclassifying the Inbox as a peer task', async () => {
  const f = await childFixture()
  try {
    const classified = await f.journal.append(events.subagentMessageClassifiedEvent, () => ({ ...f.id, inbox: f.inbox!.stored.eventId,
      kind: 'task' as const, classification: 'eligible' as const, reasonCode: 'authorized-task' }))
    await f.agent.abandonInput({ kind: 'subagent', eventId: classified.stored.eventId })
    expect(f.agent.snapshot().inputs).toMatchObject([{ status: 'abandoned' }])
    expect(f.agent.snapshot().controls.at(-1)?.requested.stored.payloadVersion).toBe(3)
    await f.agent.start()
    expect(f.agent.snapshot().roots).toHaveLength(0)
  } finally { await f.close() }
})

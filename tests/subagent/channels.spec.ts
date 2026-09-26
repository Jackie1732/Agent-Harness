import { expect, it } from 'vitest'
import { createMessageCatalog } from '../../src/communication/message-catalog.js'
import { DelegationChannels } from '../../src/communication/delegation-channels.js'
import { ProtocolCapacity } from '../../src/communication/protocol-capacity.js'
import { subagentMessageDefinitions } from '../../src/subagent/messages.js'
import * as events from '../../src/subagent/session-events.js'
import { createCommunicationService, requestMessage, limits } from '../communication/fixtures.js'
import { observedAt } from '../agent/fixtures.js'
import { childFixture } from './child-fixture.js'

it('reserves both directions, forbids ordinary protocol sends, and delivers a leased task through the normal dispatcher', async () => {
  const f = await childFixture(false)
  const c = createCommunicationService({ maxPendingOutbox: 4, maxPendingInbox: 4 })
  try {
    const lease = await c.service.delegationChannels.restore(f.parent.session, f.cp)
    c.service.delegationChannels.bindChild(lease, f.session)
    for (const journal of [f.parent.journal, f.journal]) await journal.append(events.subagentResourceOpenedEvent, () => ({ ...f.id,
      component: 'protocol' as const, generation: 1, predecessor: null, recovery: null, workspaceGrant: { kind: 'none' as const } }))
    const installed = f.agent.snapshot()
    await f.parent.journal.append(events.subagentProvisionSettledEvent, () => ({ ...f.id, outcome: 'installed' as const,
      child: { bound: installed.subagents.bound!.stored.eventId, profile: installed.spec!.payload.profileEventId, spec: installed.spec!.stored.eventId,
        ready: installed.subagents.ready!.stored.eventId, execution: f.opened.stored.eventId,
        protocol: installed.subagents.resources.find(item => item.opened.payload.component === 'protocol')!.opened.stored.eventId },
      phase: 'published' as const, cleanup: 'not-needed' as const, reasonCode: 'fixture-published' }))
    const catalog = createMessageCatalog([...subagentMessageDefinitions, requestMessage])
    const parent = await c.service.attach(f.parent.session, { catalog, policy: c.policy })
    const child = await c.service.attach(f.session, { catalog, policy: { canSend: () => ({ kind: 'deny', reasonCode: 'static' }), canReceive: () => ({ kind: 'deny', reasonCode: 'static' }) } })
    const request = { kind: 'root' as const, recipient: f.session.header.address, channelId: f.parent.requested.channelId }
    await parent.send(requestMessage, request, { text: 'ordinary' })
    await expect(parent.send(requestMessage, request, { text: 'cannot consume held quota' })).rejects.toThrow('Outbox pending limit')
    const task = subagentMessageDefinitions.find(item => item.type === 'subagent/task')!
    await expect(parent.send(task, request, f.envelope.payload)).rejects.toThrow('requires a channel lease')
    const command = { kind: 'send' as const, request, type: 'subagent/task', payloadVersion: 1, payload: f.envelope.payload }
    const protocol = await f.parent.journal.append(events.subagentProtocolRecordedEvent, () => ({ ...f.id, kind: 'task' as const, ordinal: 1,
      command, source: { kind: 'delegation' as const, requested: f.id.delegation }, observedAt }))
    const key = { eventId: protocol.stored.eventId, index: 0 }
    const accepted = await c.service.sendDelegationOnce(parent, lease, key, command)
    c.service.delegationChannels.revoke(lease)
    expect(await c.service.sendDelegationOnce(parent, lease, key, command)).toEqual(accepted)
    const report = await c.service.createDispatcher(parent).dispatch()
    expect(report.delivered).toBe(1)
    expect(report.rejected).toBe(1)
    expect(child.snapshot().inbox).toMatchObject([{ envelope: { type: 'subagent/task' } }])
    expect(parent.snapshot().outbox.find(item => item.messageId === accepted.messageId)?.status).toBe('delivered')
  } finally { await c.service.dispose(); await c.transport.dispose(); await c.directory.dispose(); await f.close() }
})

it('rejects mailbox reservation exhaustion before the CP-D callback runs', async () => {
  const f = await childFixture(false)
  try {
    const channels = new DelegationChannels({ ...limits, maxPendingInbox: 3 })
    let committed = false
    await expect(channels.admit(f.parent.session, f.parent.requested, async () => { committed = true; return f.cp })).rejects.toThrow('reservation exceeds capacity')
    expect(committed).toBe(false)
  } finally { await f.close() }
})

it('counts another protocol consumer against the same mailbox reservation gate', async () => {
  const f = await childFixture(false)
  try {
    const capacity = new ProtocolCapacity({ ...limits, maxPendingOutbox: 4, maxPendingInbox: 4 })
    const channels = new DelegationChannels(capacity.limits, capacity)
    await channels.restore(f.parent.session, f.cp)
    await expect(capacity.run(async () => capacity.check(new Map([[f.parent.session.header.address,
      { inbox: 4, outbox: 4 }]]), new Map([[f.parent.session.header.address, f.parent.session]]))))
      .rejects.toThrow('reservation exceeds capacity')
  } finally { await f.close() }
})

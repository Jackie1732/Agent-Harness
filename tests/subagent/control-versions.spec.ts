import { expect, it } from 'vitest'
import { formatSessionAddress, parseSessionId } from '../../src/session/ids.js'
import { createChannelId } from '../../src/communication/ids.js'
import * as events from '../../src/subagent/session-events.js'
import { delegationFixture } from './fixtures.js'

it('keeps v1 Session-wide control uniqueness and accepts v2 reuse only for a different delegation', async () => {
  const f = await delegationFixture()
  try {
    const first = await f.journal.append(events.delegationRequestedEvent, () => f.requested)
    await f.agent.submitInput({ kind: 'task', text: 'A separate root', originLabel: 'test' })
    await f.agent.start()
    const childSessionId = parseSessionId('30000000-0000-4000-8000-000000000104')
    const second = await f.journal.append(events.delegationRequestedEvent, () => ({ ...f.requested,
      parentRoot: f.agent.snapshot().roots.at(-1)!.id, childSessionId, childAddress: formatSessionAddress(childSessionId), channelId: createChannelId() }))
    const control = (cp: typeof first) => ({ delegation: cp.stored.eventId, parentAddress: cp.payload.parentAddress, childAddress: cp.payload.childAddress,
      kind: 'cancel' as const, source: { kind: 'controller' as const, requestKey: 'same-source' }, reasonCode: 'test', observedAt: cp.payload.observedAt })
    const original = await f.journal.append(events.subagentControlRequestedEvent, () => control(first))
    await expect(f.journal.append(events.subagentControlRequestedEvent, () => control(second))).rejects.toThrow('duplicate-subagent-control')
    const successor = await f.journal.append(events.subagentControlRequestedV2Event, () => control(second))
    await expect(f.journal.append(events.subagentControlRequestedV2Event, () => control(second))).rejects.toThrow('duplicate-subagent-control')
    expect(f.agent.snapshot().subagents.controls.map(item => item.requested.stored.payloadVersion)).toEqual([1, 2])
    expect(original.stored.eventId).not.toBe(successor.stored.eventId)
  } finally { await f.close() }
})

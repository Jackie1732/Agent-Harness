import { expect, it } from 'vitest'
import { openHost } from '../../src/index.js'
import { agentControlSettledEvent } from '../../src/agent/session-events.js'
import type { HostRuntimeBindings } from '../../src/host/slot.js'
import { controlClock, waitingDelegations } from './subagent-control-fixture.js'

it.each(['suspended', 'restored'] as const)('retains both %s Child Sessions across parent mailbox removal and protocol resumption', async phase => {
  const f = await waitingDelegations({ count: 2 })
  let host: Awaited<ReturnType<typeof openHost>> | undefined
  let resumedProviders = 0
  const bindings: HostRuntimeBindings = { createModelProvider: member => {
    if (member.agentKey.startsWith('child.')) resumedProviders++
    return f.bindings.createModelProvider!(member)
  } }
  try {
    await f.host.run()
    expect(f.childCalls()).toBe(2)
    const relations = f.host.delegationReport().delegations
    const targets = relations.map(relation => ({ kind: 'child' as const, parentAgentKey: 'writer',
      parentRoot: relation.parentRoot, delegationId: relation.delegationId }))
    const before = await Promise.all(targets.map(target => f.host.read().events(target, { maxEvents: 512 })))
    expect(before.every(page => !page.hasMore)).toBe(true)
    for (const page of before) expect(page.events.filter(event => event.type === 'agent/turn-started')).toHaveLength(1)
    await f.host.shutdown()
    host = await openHost(f.spec, { clock: controlClock, bindings })
    expect(host.delegationReport().delegations.map(relation => relation.childSessionId)).toEqual(before.map(page => page.sessionId))
    expect(host.delegationReport().delegations.every(relation => relation.suspended)).toBe(true)
    if (phase === 'restored') expect(host.resume('writer')).toMatchObject([{ status: 'resumed' }, { status: 'resumed' }])
    await host.setMailboxOnline('writer', false, 'cancel')
    await host.setMailboxOnline('writer', true)
    expect(host.resume('writer')).toMatchObject([{ status: 'resumed' }, { status: 'resumed' }])
    for (const relation of relations) await host.cancel('writer', relation.parentRoot)
    for (let i = 0; i < 12 && host.delegationReport().unresolved > 0; i++) await host.run()
    expect(host.delegationReport()).toMatchObject({ unresolved: 0, blocked: 0, active: 0 })
    expect(host.delegationReport().delegations.every(relation => relation.closed && relation.executionReleased && !relation.adopted)).toBe(true)
    const after = await Promise.all(targets.map(target => host!.read().events(target, { maxEvents: 512 })))
    for (let i = 0; i < before.length; i++) {
      expect(after[i]!.hasMore).toBe(false)
      expect(after[i]!.sessionId).toBe(before[i]!.sessionId)
      expect(after[i]!.events.slice(0, before[i]!.events.length)).toEqual(before[i]!.events)
      expect(after[i]!.events.filter(event => event.type === 'agent/turn-started')).toHaveLength(1)
      expect(after[i]!.events.some(event => event.type === agentControlSettledEvent.type
        && agentControlSettledEvent.decode(event.payload).rootOutcome === 'cancelled')).toBe(true)
    }
    expect(resumedProviders).toBe(0)
    expect(f.childCalls()).toBe(2)
  } finally { await host?.shutdown(); await f.close() }
}, 40000)

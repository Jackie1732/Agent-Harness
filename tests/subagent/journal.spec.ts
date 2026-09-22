import { expect, it } from 'vitest'
import { AgentJournal } from '../../src/agent/journal.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { installAgentSpec } from '../../src/agent/session-agent.js'
import { agentTurnStartedEvent } from '../../src/agent/session-events.js'
import { SessionContext } from '../../src/context/session-context.js'
import { rebuildAssembly } from '../../src/context/projection.js'
import * as events from '../../src/subagent/session-events.js'
import { clock } from '../agent/fixtures.js'
import { emptyMessageCatalog } from '../context/fixtures.js'
import { delegationFixture } from './fixtures.js'

it('joins concurrent cancellation of the same waiting root with one settlement per wait and control', async () => {
  const f = await delegationFixture()
  try {
    await Promise.all([f.agent.cancel(f.requested.parentRoot), f.agent.cancel(f.requested.parentRoot)])
    const state = f.agent.snapshot()
    expect(state.roots[0]?.outcome).toBe('cancelled')
    expect(state.controls.filter(item => item.requested.payload.kind === 'cancel-work')).toHaveLength(1)
    expect(state.waits.every(item => item.settled !== null)).toBe(true)
  } finally { await f.close() }
})

it('commits the grant and protocol debit in the same parent prefix and preserves the waiting root', async () => {
  const f = await delegationFixture()
  try {
    const before = f.agent.snapshot()
    const cp = await f.journal.append(events.delegationRequestedEvent, () => f.requested)
    const state = f.agent.snapshot()
    expect(state.subagents.delegations[0]?.stored.eventId).toBe(cp.stored.eventId)
    expect(state.roots).toHaveLength(1)
    expect(state.roots[0]?.budget).toMatchObject({ models: 3, steps: 3, messages: 7, waits: 3, outputTokens: 768 })
    expect(state.waits).toEqual(before.waits)
    expect(state.openRun).toBeNull()
    const position = f.session.snapshot().localPosition
    await expect(f.journal.append(events.delegationRequestedEvent, () => f.requested)).rejects.toThrow('unresolved-delegation')
    expect(f.session.snapshot().localPosition).toBe(position)
    for (const event of f.session.snapshot().history.at(-1)!.events.filter(item => item.stored.type === 'context/assembly-committed')) {
      expect(event.stored.payloadVersion).toBe(3)
      expect(rebuildAssembly(f.session.snapshot(), event.stored.eventId).kind).toBe('rebuilt')
    }
  } finally { await f.close() }
})

it('rejects altered reserves, over-budget grants and stopped parents before appending', async () => {
  const f = await delegationFixture()
  try {
    const before = f.session.snapshot().localPosition
    await expect(f.journal.append(events.delegationRequestedEvent, () => ({ ...f.requested,
      parentProtocolReserve: { ...f.requested.parentProtocolReserve, messages: 0 } }))).rejects.toThrow('protocol-reservation-mismatch')
    await expect(f.journal.append(events.delegationRequestedEvent, () => ({ ...f.requested,
      effectivePlan: { ...f.requested.effectivePlan, childBudget: { ...f.requested.grant, models: 99 } } }))).rejects.toThrow('plan-request-mismatch')
    expect(f.session.snapshot().localPosition).toBe(before)
    await f.agent.cancel(f.requested.parentRoot)
    await expect(f.journal.append(events.delegationRequestedEvent, () => f.requested)).rejects.toThrow('parent-not-admissible')
  } finally { await f.close() }
})

it('requires actual child binding, profile and spec commits before readiness and keeps failed release sticky', async () => {
  const f = await delegationFixture()
  let context: SessionContext | undefined
  try {
    const cp = await f.journal.append(events.delegationRequestedEvent, () => f.requested)
    const child = await f.repo.create({ sessionId: f.requested.childSessionId })
    const journal = new AgentJournal(child, 4, clock)
    const id = { delegation: cp.stored.eventId, parentAddress: f.requested.parentAddress, childAddress: child.header.address }
    const bound = await journal.append(events.childBoundEvent, () => ({ ...id, requested: f.requested }))
    context = new SessionContext({ session: child, messageCatalog: emptyMessageCatalog })
    const profile = await context.recordProfile(f.template.profile)
    const spec = await installAgentSpec(child, { ...f.template.spec, profileEventId: profile.stored.eventId, budget: f.requested.grant,
      subagents: { role: 'child', bound: bound.stored.eventId, deadline: f.requested.deadline,
        protocolReserve: f.requested.childProtocolReserve, maxQuestions: 2, maxProgress: 1, maxFileEntries: 8 } }, clock)
    const ready = await journal.append(events.childReadyEvent, (_, snapshot) => ({ ...id, bound: bound.stored.eventId,
      profile: profile.stored.eventId, spec: spec.stored.eventId, through: snapshot.localPosition }))
    expect(projectAgentSession(child.snapshot()).subagents.ready?.stored.eventId).toBe(ready.stored.eventId)
    const resource = await journal.append(events.subagentResourceOpenedEvent, () => ({ ...id, generation: 1,
      component: 'execution' as const, predecessor: null, recovery: null, workspaceGrant: { kind: 'none' as const } }))
    const released = await journal.append(events.subagentReleaseRecordedEvent, () => ({ ...id, opened: resource.stored.eventId,
      component: 'execution' as const, outcome: 'cleanup-incomplete' as const, reasonCode: 'provider-close-failed' }))
    await expect(journal.append(events.subagentResourceOpenedEvent, () => ({ ...id, generation: 2, component: 'execution' as const,
      predecessor: released.stored.eventId, recovery: null, workspaceGrant: { kind: 'none' as const } }))).rejects.toThrow('resource-predecessor')
  } finally { await context?.dispose(); await f.close() }
})

it('does not allow a v1 turn event to bypass a v2 spec', async () => {
  const f = await delegationFixture()
  try {
    const turn = f.agent.snapshot().turns[0]!
    const { protocolSource: _protocol, ...legacy } = turn.started.payload
    await expect(f.journal.append(agentTurnStartedEvent, () => legacy)).rejects.toThrow('agent-event-spec-version')
  } finally { await f.close() }
})

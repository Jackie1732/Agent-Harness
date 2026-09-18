import { expect, it } from 'vitest'
import { createDurableEventDefinition, projectAgentSession, recoverAgentSession } from '../../src/index.js'
import { agentFixture, clock, observedAt } from './fixtures.js'
import { auditedAgent } from './audit-fixtures.js'
import { selectAgentInput } from '../../src/agent/scheduling.js'
import { emptyMessageCatalog, repository, profile } from '../context/fixtures.js'
import { SessionContext, communicationSessionEventDefinitions, toolSessionEventDefinitions } from '../../src/index.js'
import * as events from '../../src/agent/session-events.js'

for (const version of [1, 2]) it('preserves legacy abandonment races and excludes new claims; version=' + version, async () => {
  const f = await agentFixture()
  try {
    const input = await f.journal.append(events.agentInputAcceptedEvent, () => ({ spec: f.installed.stored.eventId, input: { kind: 'task' as const, text: 'task', originLabel: 'audit' } }))
    const reference = { kind: 'user' as const, eventId: input.stored.eventId }
    const run = await f.journal.append(events.agentRunStartedEvent, () => ({ spec: f.installed.stored.eventId, kind: 'drive' as const }))
    const control = await f.journal.append(version === 1 ? events.agentControlRequestedEvent : events.agentInputAbandonRequestedEvent,
      () => ({ kind: 'abandon-input' as const, input: reference, reason: 'abandon' }))
    expect(selectAgentInput(projectAgentSession(f.session.snapshot()), emptyMessageCatalog)).toBeNull()
    const claim = f.journal.append(events.agentTurnStartedEvent, () => ({ run: run.stored.eventId, input: reference, lane: 'user', ordinal: 1, root: null, predecessor: null, deadline: null, observedAt }))
    if (version === 2) await expect(claim).rejects.toMatchObject({ code: 'AGENT_STATE_INVALID' })
    else await claim
    const result = await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 20, maxJournalConflicts: 4, clock })
    expect(result.kind).toBe('recovered'); expect(result.report.pendingControls).toEqual([])
    expect(result.report.inputs[0]?.status).toBe(version === 1 ? 'review-required' : 'abandoned')
    const settled = projectAgentSession(f.session.snapshot()).controls.find(item => item.requested.stored.eventId === control.stored.eventId)!.settled!
    expect(settled.payload.outcome).toBe(version === 1 ? 'no-op' : 'completed')
    expect(settled.stored.payloadVersion).toBe(version === 1 ? 2 : 1)
    expect((await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 20, maxJournalConflicts: 4, clock })).kind).toBe('nothing-to-recover')
  } finally { await f.close() }
})

it('a claim that wins first rejects abandonment without creating a control', async () => {
  const f = await agentFixture(); const agent = auditedAgent(f)
  try {
    const accepted = await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'audit' })
    const run = await f.journal.append(events.agentRunStartedEvent, () => ({ spec: f.installed.stored.eventId, kind: 'drive' as const }))
    const reference = { kind: 'user' as const, eventId: accepted.stored.eventId }
    await f.journal.append(events.agentTurnStartedEvent, () => ({ run: run.stored.eventId, input: reference, lane: 'user', ordinal: 1, root: null, predecessor: null, deadline: null, observedAt }))
    await expect(agent.abandonInput(reference)).rejects.toMatchObject({ code: 'AGENT_STATE_INVALID' })
    expect(agent.snapshot().controls).toEqual([])
    await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 20, maxJournalConflicts: 4, clock })
  } finally { await agent.dispose(); await f.close() }
})

it('recognizes only the built-in version of Session ended while replaying queued input', async () => {
  const otherEnded = createDurableEventDefinition({ type: 'session/ended', payloadVersion: 2, ignorable: false, decode: () => ({ note: 'extension' }) })
  const repo = repository(undefined, [...events.agentSessionEventDefinitions, ...communicationSessionEventDefinitions, ...toolSessionEventDefinitions, otherEnded])
  const f = await agentFixture()
  try {
    const session = await repo.create(); const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
    const p = await context.recordProfile(profile('generation', { rendererVersion: 'context-neutral/v2' }))
    await session.append(events.agentSpecRecordedEvent, { ...f.spec, profileEventId: p.stored.eventId })
    await session.append(events.agentInputAcceptedEvent, { spec: session.snapshot().history.at(-1)!.events.at(-1)!.stored.eventId, input: { kind: 'task', text: 'pending', originLabel: 'audit' } })
    await session.append(otherEnded, { note: 'extension' })
    expect(session.snapshot().lifecycle).toBe('active'); expect(projectAgentSession(session.snapshot()).inputs[0]?.status).toBe('queued')
    await context.dispose()
    await session.end('invalid Agent shutdown')
    expect(() => projectAgentSession(session.snapshot())).toThrowError(expect.objectContaining({ code: 'AGENT_STATE_INVALID' }))
  } finally { await repo.dispose(); await f.close() }
})

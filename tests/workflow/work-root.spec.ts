import { expect, it } from 'vitest'
import { rebuildAssembly, recoverAgentSession } from '../../src/index.js'
import { workAssignmentAcceptedEvent } from '../../src/workflow/work-binding.js'
import { workflowRunStartedEvent, workflowTurnStartedEvent, agentStepOpenedEvent } from '../../src/agent/session-events.js'
import { clock, observedAt } from '../agent/fixtures.js'
import { workFixture as fixture } from './work-fixture.js'

it('isolates work input and context from ordinary roots, and runs one selected turn', async () => {
  const f = await fixture()
  try {
    await f.agent.submitInput({ kind: 'task', text: 'PRIVATE prior ordinary root', originLabel: 'user' })
    await f.agent.start()
    await f.agent.submitInput({ kind: 'task', text: 'PRIVATE queued ordinary input', originLabel: 'user' })
    const accepted = await f.assign()
    const selection = { kind: 'workflow' as const, assignment: accepted.payload.assignment }
    await f.agent.start()
    expect(f.calls()).toBe(1)
    await f.agent.start({ selection })
    const state = f.agent.snapshot()
    expect(state.roots).toHaveLength(2)
    expect(state.roots[1]).toMatchObject({ source: selection, limit: accepted.payload.value.effectiveAllowance, outcome: 'completed' })
    expect(state.inputs.find(input => input.input?.text.includes('queued ordinary'))?.status).toBe('queued')
    const assembly = f.context.snapshot().assemblies.at(-1)!.committed
    const rebuilt = rebuildAssembly(f.session.snapshot(), assembly.stored.eventId)
    expect(rebuilt.kind).toBe('rebuilt')
    expect(JSON.stringify(assembly.payload.request)).not.toContain('PRIVATE')
    expect(JSON.stringify(assembly.payload.request)).toContain('Read the assigned passage')
    expect(assembly.stored.payloadVersion).toBe(4)
    expect(state.runs.at(-1)?.started.payload).toMatchObject({ selection })
    await expect(f.journal.append(workAssignmentAcceptedEvent, () => accepted.payload)).rejects.toThrow('duplicate-work-accept')
  } finally { await f.close() }
})

it('resumes a human answer in the same work root with its original grant', async () => {
  const f = await fixture(true)
  try {
    const accepted = await f.assign()
    const selection = { kind: 'workflow' as const, assignment: accepted.payload.assignment }
    await f.agent.start({ selection })
    expect(f.agent.snapshot().turns[0]?.settled?.payload.outcome).toBe('waiting')
    const root = f.agent.snapshot().roots[0]!
    const wait = f.agent.snapshot().waits[0]!
    await f.agent.submitInput({ kind: 'answer', wait: wait.reference, text: 'Approved source', originLabel: 'user' })
    await f.agent.start()
    expect(f.calls()).toBe(1)
    await f.agent.start({ selection })
    expect(f.agent.snapshot().roots).toHaveLength(1)
    expect(f.agent.snapshot().roots[0]).toMatchObject({ id: root.id, deadline: root.deadline, limit: root.limit, outcome: 'completed', budget: { models: 2, waits: 1 } })
  } finally { await f.close() }
})

it('rejects a changed CP-ROOT allowance and preserves the work claim after recovery', async () => {
  const f = await fixture()
  try {
    const accepted = await f.assign()
    const run = await f.journal.append(workflowRunStartedEvent, state => ({ spec: state.spec!.stored.eventId, kind: 'drive' as const,
      selection: { kind: 'workflow' as const, assignment: accepted.payload.assignment } }))
    const input = f.agent.snapshot().inputs[0]!
    const binding = { accepted: accepted.stored.eventId, assignment: accepted.payload.assignment,
      allowance: accepted.payload.value.effectiveAllowance, toolNames: [], nativeActions: [] }
    const turn = { run: run.stored.eventId, input: input.reference, lane: input.lane, ordinal: 1, root: null, predecessor: null,
      deadline: accepted.payload.value.deadline, observedAt, protocolSource: accepted.payload.inbox, work: binding }
    await expect(f.journal.append(workflowTurnStartedEvent, () => ({ ...turn, work: { ...binding,
      allowance: { ...binding.allowance, models: binding.allowance.models + 1 } } }))).rejects.toThrow('turn-work-selection')
    const claimed = await f.journal.append(workflowTurnStartedEvent, () => turn)
    await f.journal.append(agentStepOpenedEvent, () => ({ turn: claimed.stored.eventId, ordinal: 1, outputTokens: 256, observedAt }))
    await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 16, maxJournalConflicts: 4, clock })
    expect(f.agent.snapshot().openRun).toBeNull()
    expect(f.agent.snapshot().roots[0]?.source).toEqual({ kind: 'workflow', assignment: accepted.payload.assignment })
    expect(f.calls()).toBe(0)
    await f.agent.start({ selection: { kind: 'workflow', assignment: accepted.payload.assignment } })
    expect(f.agent.snapshot().roots).toHaveLength(1)
  } finally { await f.close() }
})

it('stops a continuation when the assignment grant is spent even though the Spec has budget left', async () => {
  const f = await fixture(true, 1)
  try {
    const accepted = await f.assign()
    const selection = { kind: 'workflow' as const, assignment: accepted.payload.assignment }
    await f.agent.start({ selection })
    await f.agent.submitInput({ kind: 'answer', wait: f.agent.snapshot().waits[0]!.reference, text: 'source', originLabel: 'user' })
    await f.agent.start({ selection })
    expect(f.calls()).toBe(1)
    expect(f.agent.snapshot().roots[0]).toMatchObject({ limit: { models: 1 }, budget: { models: 1 }, outcome: 'budget-exhausted' })
    expect(f.spec.budget.models).toBe(5)
  } finally { await f.close() }
})

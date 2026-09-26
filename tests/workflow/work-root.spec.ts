import { expect, it } from 'vitest'
import { SessionAgent, SessionContext, SessionModelRunner, installAgentSpec, createMessageCatalog, createMessageDefinition,
  agentSessionEventDefinitions, subagentSessionEventDefinitions, communicationSessionEventDefinitions, toolSessionEventDefinitions,
  ScriptedModelProvider, parseSessionId, parseChannelId, rebuildAssembly, recoverAgentSession } from '../../src/index.js'
import type { AgentSpecV3, JsonObject, ModelFrame } from '../../src/index.js'
import { snapshotJson } from '../../src/foundation/json.js'
import { workAssignmentAcceptedEvent, decodeWorkAssignmentMessage } from '../../src/workflow/work-binding.js'
import { WorkflowAdmission } from '../../src/workflow/admission.js'
import { workflowDefinitionRecordedEvent, workflowSessionEventDefinitions } from '../../src/workflow/session-events.js'
import { AgentJournal } from '../../src/agent/journal.js'
import { workflowRunStartedEvent, workflowTurnStartedEvent, agentStepOpenedEvent } from '../../src/agent/session-events.js'
import { agentSpec, clock, observedAt } from '../agent/fixtures.js'
import { repository, profile, runnerLimits } from '../context/fixtures.js'
import { createCommunicationService } from '../communication/fixtures.js'
import { workflowFixture } from './fixtures.js'

async function fixture(actions = false, models = 2) {
  let calls = 0
  const provider = new ScriptedModelProvider({ providerId: 'work-model', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    script: async function* (): AsyncGenerator<ModelFrame> {
      calls++
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: `result-${calls}` }
      if (actions && calls === 1) {
        yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'ask' }
        yield { kind: 'arguments-delta', index: 0, text: '{"question":"Which source?","timeoutMs":1000}' }
      } else {
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: '{"text":"work result"}' }
      }
      yield { kind: 'block-end', index: 0 }
      yield { kind: 'complete', stopReason: actions && calls === 1 ? 'tool-calls' : 'stop' }
    } })
  const repo = repository(undefined, [...agentSessionEventDefinitions, ...subagentSessionEventDefinitions,
    ...communicationSessionEventDefinitions, ...toolSessionEventDefinitions, ...workflowSessionEventDefinitions])
  const session = await repo.create({ sessionId: parseSessionId('87000000-0000-4000-8000-000000000002') })
  const coordinator = await repo.create({ sessionId: parseSessionId('87000000-0000-4000-8000-000000000001') })
  const definition = createMessageDefinition({ type: 'workflow/assignment', payloadVersion: 1,
    decode: value => snapshotJson(decodeWorkAssignmentMessage(value)) as JsonObject })
  const catalog = createMessageCatalog([definition])
  const context = new SessionContext({ session, messageCatalog: catalog })
  const recorded = await context.recordProfile(profile('generation', { rendererVersion: 'context-neutral/v4' }))
  const spec: AgentSpecV3 = { ...agentSpec(recorded.stored.eventId, provider), protocolVersion: 3,
    context: { history: { mode: 'completed-roots', maxRoots: 5 }, memory: { required: [], query: { requiredTags: [], queryTags: [], topK: 5 } }, compactions: [] },
    subagents: { role: 'none' }, workflow: { kind: 'participant', toolNames: [], nativeActions: ['agent_ask_user'], resourceIds: [] } }
  await installAgentSpec(session, spec, clock)
  const { service, policy } = createCommunicationService({ maxMessageBytes: 128 * 1024, maxPendingInbox: 128, maxPendingOutbox: 128 })
  const sender = await service.attach(coordinator, { catalog, policy })
  const receiver = await service.attach(session, { catalog, policy })
  const agent = new SessionAgent({ session, context, model: new SessionModelRunner({ session, provider, limits: runnerLimits }),
    mailbox: receiver, messageCatalog: catalog, clock })
  const base = workflowFixture()
  const grant = { models, steps: 2, tools: 0, messages: 0, waits: 1, outputTokens: 512 }
  const recipe = { ...base, budget: { ...base.budget, outputTokens: 2048 },
    roster: base.roster.map(member => ({ ...member, budgetCeiling: grant })),
    nodes: base.nodes.map(node => ({ ...node, attempts: node.attempts.map(attempt => ({ ...attempt, workerGrant: grant,
      nativeActions: actions ? ['agent_ask_user'] : [] })) })) }
  const saved = await coordinator.append(workflowDefinitionRecordedEvent, { definition: recipe })
  const journal = new AgentJournal(session, 4, clock)
  async function assign() {
    const work = await new WorkflowAdmission(coordinator, service.protocolCapacity, clock).admitRoot('read', session,
      parseChannelId('71000000-0000-4000-8000-000000000101'), () => undefined)
    const payload = snapshotJson({ definition: { address: coordinator.header.address, eventId: saved.stored.eventId },
      assignment: { address: coordinator.header.address, eventId: work.stored.eventId }, recipe, value: work.payload }) as JsonObject
    await sender.send(definition, { kind: 'root', recipient: session.header.address, channelId: work.payload.channelId }, payload)
    await service.createDispatcher(sender).dispatch()
    const inbox = receiver.snapshot().inbox[0]!
    const accepted = await journal.append(workAssignmentAcceptedEvent, () => workAssignmentAcceptedEvent.decode({ ...payload, inbox: inbox.acceptedEventId }))
    return accepted
  }
  return { repo, session, coordinator, agent, journal, context, spec, assign, calls: () => calls,
    close: async () => { await agent.dispose(); await service.dispose(); await provider.dispose(); await repo.dispose() } }
}

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

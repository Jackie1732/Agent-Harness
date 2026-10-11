import { expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '../../src/foundation/json.js'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import type { HostRuntimeBindings } from '../../src/host/slot.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { parseSessionId } from '../../src/session/ids.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { workflowDefinitionRecordedEvent } from '../../src/workflow/definition-events.js'
import { workflowAssignmentClosed } from '../../src/workflow/closure.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { runnableWorkflowHost } from './host-fixture.js'

function reviewedHost(root: string, scenario: 'capacity' | 'members', maximum = 2) {
  const base = runnableWorkflowHost(root)
  if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
  const entry = base.workflows.definitions[0]!, producer = entry.definition.nodes[0]!
  const grant = { models: 2, steps: 2, tools: 0, messages: 0, waits: 1, outputTokens: 512 }
  const reviewGrant = { ...grant, models: 1, steps: 1, waits: 0, outputTokens: 256 }
  const members = base.members.map(member => {
    if (member.kind !== 'local' || member.spec.protocolVersion !== 3 || member.spec.workflow.kind !== 'participant') throw new Error('participant fixture')
    return { ...member, spec: { ...member.spec, budget: grant,
      workflow: { ...member.spec.workflow, nativeActions: ['agent_ask_user' as const] } },
    model: { ...member.model, runnerLimits: { ...member.model.runnerLimits, maxToolCalls: 1 } } }
  })
  members.push({ ...members[1]!, agentKey: 'editor', sessionId: '70000000-0000-4000-8000-000000000103' })
  const roster = [...entry.definition.roster, { ...entry.definition.roster[1]!, memberKey: 'editor',
    address: 'ah-session:70000000-0000-4000-8000-000000000103' }].map((member, index) => ({ ...member,
      ...workflowMemberFingerprints(members[index]!), budgetCeiling: grant,
      canReview: scenario === 'members' || member.memberKey === 'editor' }))
  const nodes = entry.definition.nodes.map(node => {
    const reviewer = scenario === 'members' ? node.executor === 'writer' ? 'reviewer' : 'writer' : 'editor'
    return { ...node, dependencies: [], inputs: [], inputSchema: producer.inputSchema,
      output: producer.output, acceptance: { kind: 'reviewed-all', reviewers: [reviewer] },
      attempts: [{ ...producer.attempts[0], workerGrant: grant, nativeActions: ['agent_ask_user'],
        reviewerGrants: [{ memberKey: reviewer, grant: reviewGrant }] }] }
  })
  const definition = decodeWorkflowDefinition({ ...entry.definition, requiredOutputs: ['read', 'write'], roster, nodes,
    communication: { ask: [], groups: [], disclosures: nodes.map(node => ({ nodeKey: node.nodeKey,
      recipients: ['coordinator', ...node.acceptance.reviewers] })) },
    budget: { ...grant, models: 6, steps: 6, waits: 2, outputTokens: 1536 },
    limits: { ...entry.definition.limits, maxActiveAssignments: maximum, maxProtocolMessages: 24 } })
  const definitions = scenario === 'capacity' ? [{ ...entry, definition }] : nodes.map((node, index) => {
    const workflowKey = index === 0 ? 'research' : 'second'
    const sessionId = index === 0 ? entry.sessionId : '87000000-0000-4000-8000-000000000004'
    return { sessionId, definition: decodeWorkflowDefinition({ ...definition, workflowKey,
      coordinator: 'ah-session:' + sessionId, nodes: [node], requiredOutputs: [node.nodeKey],
      communication: { ...definition.communication, disclosures: [definition.communication.disclosures[index]] } }) }
  })
  return { ...base, members, routes: [...base.routes, { ...base.routes[1]!, memberKey: 'editor', sessionId: members[2]!.sessionId }],
    shutdown: { ...base.shutdown, mode: 'drain' as const },
    workflows: { ...base.workflows, definitions } }
}

function reviewingProvider(calls: Map<string, number>): HostRuntimeBindings {
  return { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    script: async function* (submission): AsyncGenerator<ModelFrame> {
      const count = (calls.get(member.agentKey) ?? 0) + 1
      calls.set(member.agentKey, count)
      const review = JSON.stringify(submission.request).includes('Review the exact candidate')
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'review-admission-' + count }
      if (member.agentKey === 'writer' && count === 1 && !review) {
        yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'production-wait' }
        yield { kind: 'arguments-delta', index: 0, text: '{"question":"Complete the first production?","timeoutMs":60000}' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } else {
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: review
          ? '{"decision":"accept","reason":"checked the exact candidate"}' : '{"text":"candidate"}' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      }
    } }) }
}

it('rejects an impossible new review ceiling before Headers while preserving old definition@1 readers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-audit-review-minimum-'))
  try {
    const spec = reviewedHost(root, 'capacity', 1)
    await expect(initializeHost(spec)).rejects.toMatchObject({ code: 'HOST_CONFIG_INVALID', message: 'workflow-review-capacity-insufficient' })
    expect(await readdir(root)).toEqual([])
    const historical = spec.workflows.definitions[0]!
    const storage = { ...spec.storage, root: join(root, 'historical') }
    const repository = new SessionRepository({ backend: new FileSessionBackend(storage),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const coordinator = await repository.create({ sessionId: parseSessionId(historical.sessionId) })
      await coordinator.append(workflowDefinitionRecordedEvent, { definition: historical.definition as unknown as JsonObject })
    } finally { await repository.dispose() }
    const reader = new SessionRepository({ backend: new FileSessionBackend(storage),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const snapshot = await reader.read(parseSessionId(historical.sessionId))
      expect(snapshot.localPosition).toBe(1)
      expect(projectWorkflowSession(snapshot).definition!.payload).toEqual(historical.definition)
      expect(projectWorkflowSession(snapshot).definition!.payload.limits.maxActiveAssignments).toBe(1)
    } finally { await reader.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps an assignment opportunity for fixed reviewers when another ready production could fill the ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-audit-review-capacity-'))
  try {
    const spec = reviewedHost(root, 'capacity')
    await initializeHost(spec)
    const calls = new Map<string, number>()
    const host = await openHost(spec, { bindings: reviewingProvider(calls) })
    try {
      await host.workflow('research').resume({ requestKey: 'review-capacity' })
      await host.run()
      expect(host.workflow('research').report()).toMatchObject({ state: 'running', counts: { assignments: 1, reviews: 0 } })
      expect(calls.get('reviewer')).toBeUndefined()
      const wait = host.report().members.find(member => member.agentKey === 'writer')!.agent.waits[0]!
      await host.submitAnswer('writer', wait.reference, 'Continue')
      await host.run()
      expect(host.workflow('research').report()).toMatchObject({ state: 'completed', closed: true,
        counts: { assignments: 4, reviews: 2, accepted: 2 }, reservedBudget: { models: 6, steps: 6, outputTokens: 1536 } })
      expect(calls).toEqual(new Map([['writer', 2], ['editor', 2], ['reviewer', 1]]))
    } finally { await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 40_000)

it('retains reviewer members across coordinators and reconstructs those reservations after a drain and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-audit-review-members-'))
  try {
    const spec = reviewedHost(root, 'members', 16)
    await initializeHost(spec)
    const calls = new Map<string, number>(), bindings = reviewingProvider(calls)
    const host = await openHost(spec, { bindings })
    let wait
    try {
      await host.workflow('research').resume({ requestKey: 'first-start' })
      await host.workflow('second').resume({ requestKey: 'second-start' })
      await host.run()
      expect(host.workflow('research').report().counts.assignments).toBe(1)
      expect(host.workflow('second').report().counts.assignments).toBe(0)
      expect(calls.get('reviewer')).toBeUndefined()
      wait = host.report().members.find(member => member.agentKey === 'writer')!.agent.waits[0]!
      expect(wait.settled).toBeNull()
    } finally { await host.shutdown() }
    const reopened = await openHost(spec, { bindings })
    try {
      await reopened.workflow('research').resume({ requestKey: 'first-reopen' })
      await reopened.workflow('second').resume({ requestKey: 'second-reopen' })
      await reopened.run()
      expect(reopened.workflow('second').report().counts.assignments).toBe(0)
      expect(calls.get('reviewer')).toBeUndefined()
      await reopened.submitAnswer('writer', wait.reference, 'Continue')
      await reopened.run()
      for (const key of ['research', 'second']) expect(reopened.workflow(key).report()).toMatchObject({ state: 'completed', closed: true,
        counts: { assignments: 2, reviews: 1, accepted: 1 }, reservedBudget: { models: 3, steps: 3, outputTokens: 768 } })
      expect(calls).toEqual(new Map([['writer', 3], ['reviewer', 2]]))
    } finally { await reopened.shutdown() }
    const reader = new SessionRepository({ backend: new FileSessionBackend(spec.storage),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      for (const entry of spec.workflows.definitions) {
        const state = projectWorkflowSession(await reader.read(parseSessionId(entry.sessionId)))
        expect(state.assignments.map(assignment => assignment.payload.kind)).toEqual(['production', 'review'])
        expect(state.closed).not.toBeNull()
      }
    } finally { await reader.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 40_000)

it('reuses reviewer capacity only after its decided assignment actually closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-audit-review-closure-'))
  try {
    const base = reviewedHost(root, 'capacity')
    const entry = base.workflows.definitions[0]!, node = entry.definition.nodes[0]!
    const reviewGrant = { models: 1, steps: 1, tools: 0, messages: 0, waits: 0, outputTokens: 256 }
    const definition = decodeWorkflowDefinition({ ...entry.definition,
      roster: entry.definition.roster.map(member => ({ ...member, canReview: member.memberKey !== 'writer' })),
      nodes: [{ ...node, acceptance: { kind: 'reviewed-all', reviewers: ['reviewer', 'editor'] },
        attempts: [{ ...node.attempts[0]!, reviewerGrants: ['reviewer', 'editor'].map(memberKey => ({ memberKey, grant: reviewGrant })) }] }],
      requiredOutputs: ['read'], communication: { ...entry.definition.communication,
        disclosures: [{ nodeKey: 'read', recipients: ['coordinator', 'reviewer', 'editor'] }] } })
    const spec = { ...base, scheduling: { ...base.scheduling, maxBatchesPerRun: 1 },
      workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    const clock = { now: () => now }, now = Date.now()
    await initializeHost(spec, { clock })
    const calls = new Map<string, number>()
    const host = await openHost(spec, { clock, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (): AsyncGenerator<ModelFrame> {
        calls.set(member.agentKey, (calls.get(member.agentKey) ?? 0) + 1)
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: member.agentKey }
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: member.agentKey === 'writer'
          ? '{"text":"candidate"}' : '{"decision":"accept","reason":"checked the exact candidate"}' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      } }) } })
    const reader = new SessionRepository({ backend: new FileSessionBackend(spec.storage),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const read = async () => projectWorkflowSession(await reader.read(parseSessionId(entry.sessionId)))
      const firstReviewerDecided = (state: ReturnType<typeof projectWorkflowSession>) => state.decisions.some(decision => state.assignments.some(assignment =>
        assignment.payload.kind === 'review' && assignment.payload.memberKey === 'reviewer' && assignment.stored.eventId === decision.payload.assignment.eventId))
      await host.workflow('research').resume({ requestKey: 'review-closure' })
      let state = await read()
      for (let index = 0; index < 80 && !firstReviewerDecided(state); index++) { await host.run(); state = await read() }
      expect(firstReviewerDecided(state)).toBe(true)
      expect(state.assignments).toHaveLength(2)
      await host.setMailboxOnline('reviewer', false, 'drain')
      for (let index = 0; index < 25; index++) await host.run()
      const coordinator = await reader.read(parseSessionId(entry.sessionId))
      const peers = await Promise.all(spec.members.map(member => reader.read(parseSessionId(member.sessionId))))
      state = projectWorkflowSession(coordinator)
      const active = state.assignments.filter(assignment => !workflowAssignmentClosed(coordinator,
        peers.find(peer => peer.header.address === assignment.payload.memberAddress)!, assignment.stored.eventId, peers))
      expect(active).toHaveLength(2)
      expect(state.assignments).toHaveLength(2)
      expect(calls.get('editor')).toBeUndefined()
      await host.setMailboxOnline('reviewer', true)
      for (let index = 0; index < 80 && state.closed === null; index++) { await host.run(); state = await read() }
      expect(state.closed).not.toBeNull()
      expect(state.assignments.map(assignment => assignment.payload.kind)).toEqual(['production', 'review', 'review'])
      expect(state.reviews).toHaveLength(2)
      expect(calls).toEqual(new Map([['writer', 1], ['reviewer', 1], ['editor', 1]]))
    } finally { await reader.dispose(); await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 40_000)

import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import type { HostRuntimeBindings } from '../../src/host/slot.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { parseSessionId } from '../../src/session/ids.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { resolveWorkflowNode } from '../../src/workflow/graph.js'
import type { WorkflowUpstreamState } from '../../src/workflow/graph.js'
import { workflowNodeResolvedEvent, workflowNodeResolvedEventV2 } from '../../src/workflow/definition-events.js'
import { WorkflowJournal } from '../../src/workflow/journal.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { runnableWorkflowHost } from './host-fixture.js'
import { workflowFixture } from './fixtures.js'

it.each([false, true])('waits for a complete fan-in and gives failure priority regardless of dependency order (%s)', reverse => {
  const base = workflowFixture()
  const dependencies = [{ nodeKey: 'read', mode: 'required' }, { nodeKey: 'other', mode: 'required' }]
  const definition = decodeWorkflowDefinition({ ...base, communication: { ...base.communication,
    disclosures: [...base.communication.disclosures, { nodeKey: 'other', recipients: ['coordinator'] }],
  }, nodes: [base.nodes[0], { ...base.nodes[1], dependencies: reverse ? [...dependencies].reverse() : dependencies },
    { ...base.nodes[0], nodeKey: 'other' }] })
  const node = definition.nodes[1]!
  const upstream = new Map<string, WorkflowUpstreamState>([['read', { kind: 'skipped' }]])
  expect(resolveWorkflowNode(node, upstream, definition)).toEqual({ kind: 'blocked', reason: 'dependency-pending' })
  upstream.set('other', { kind: 'retry-awaiting-decision' })
  expect(resolveWorkflowNode(node, upstream, definition)).toEqual({ kind: 'blocked', reason: 'dependency-pending' })
  for (const kind of ['failed', 'cancelled', 'result-unknown'] as const) {
    upstream.set('other', { kind })
    expect(resolveWorkflowNode(node, upstream, definition)).toEqual({ kind: 'failed', reason: 'dependency-failed' })
  }
  upstream.set('other', { kind: 'accepted', value: { text: 'settled' } })
  expect(resolveWorkflowNode(node, upstream, definition)).toEqual({ kind: 'skipped', reason: 'required-dependency-skipped' })
})

function fanInHost(root: string) {
  const base = runnableWorkflowHost(root)
  if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
  const entry = base.workflows.definitions[0]!, seed = entry.definition.nodes[0]!, consumer = entry.definition.nodes[1]!
  const grant = { models: 2, steps: 2, tools: 0, messages: 0, waits: 1, outputTokens: 512 }
  const members = base.members.map(member => {
    if (member.kind !== 'local' || member.spec.protocolVersion !== 3 || member.spec.workflow.kind !== 'participant') throw new Error('participant fixture')
    return { ...member, spec: { ...member.spec, budget: grant,
      workflow: { ...member.spec.workflow, nativeActions: ['agent_ask_user' as const] } },
    model: { ...member.model, runnerLimits: { ...member.model.runnerLimits, maxToolCalls: 1 } } }
  })
  const definition = decodeWorkflowDefinition({ ...entry.definition, requiredOutputs: ['join'],
    roster: entry.definition.roster.map((member, index) => ({ ...member,
      ...workflowMemberFingerprints(members[index]!), budgetCeiling: grant })),
    nodes: [seed,
      { ...consumer, nodeKey: 'skip', executor: 'writer', guard: {
        kind: 'equals', nodeKey: 'read', path: ['text'], value: 'take another branch',
      } },
      { ...consumer, nodeKey: 'blocker', attempts: [{ ...consumer.attempts[0], workerGrant: grant,
        nativeActions: ['agent_ask_user'] }] },
      { ...consumer, nodeKey: 'join', executor: 'writer', inputs: [], inputSchema: seed.inputSchema,
        dependencies: [{ nodeKey: 'skip', mode: 'required' }, { nodeKey: 'blocker', mode: 'required' }] }],
    communication: { ask: [], groups: [], disclosures: [
      { nodeKey: 'read', recipients: ['coordinator', 'writer', 'reviewer'] },
      ...['skip', 'blocker', 'join'].map(nodeKey => ({ nodeKey, recipients: ['coordinator'] })),
    ] }, budget: { ...grant, models: 8, steps: 8, waits: 4, outputTokens: 2048 },
    limits: { ...entry.definition.limits, maxProtocolMessages: 24 } })
  return { ...base, members, shutdown: { ...base.shutdown, mode: 'drain' as const },
    workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
}

it.each(['current', 'legacy'] as const)('preserves a waiting File Host fan-in and reopens %s node decisions', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-audit-fanin-'))
  try {
    const spec = fanInHost(root), entry = spec.workflows.definitions[0]!
    await initializeHost(spec)
    const calls = new Map<string, number>()
    const bindings: HostRuntimeBindings = { createModelProvider: member => new ScriptedModelProvider({
      ...member.model, script: async function* () {
        const count = (calls.get(member.agentKey) ?? 0) + 1
        calls.set(member.agentKey, count)
        yield { kind: 'message-start' as const, responseId: 'fanin-' + count, reportedModel: member.spec.target.model }
        if (member.agentKey === 'reviewer' && count === 1) {
          yield { kind: 'block-start' as const, index: 0, block: 'tool-call' as const, name: 'agent_ask_user', callId: 'fanin-wait' }
          yield { kind: 'arguments-delta' as const, index: 0, text: '{"question":"Complete the second branch?","timeoutMs":60000}' }
          yield { kind: 'block-end' as const, index: 0 }; yield { kind: 'complete' as const, stopReason: 'tool-calls' }
        } else {
          yield { kind: 'block-start' as const, index: 0, block: 'text' as const }
          yield { kind: 'text-delta' as const, index: 0, text: member.agentKey === 'writer' ? '{"text":"accepted upstream"}' : 'settled second branch' }
          yield { kind: 'block-end' as const, index: 0 }; yield { kind: 'complete' as const, stopReason: 'stop' }
        }
      },
    }) }
    const host = await openHost(spec, { bindings })
    let wait
    try {
      await host.workflow('research').resume({ requestKey: 'fanin-start' })
      await host.run()
      expect(host.workflow('research').report()).toMatchObject({ state: 'running', closed: false,
        counts: { assignments: 2, accepted: 1 }, nodes: expect.arrayContaining([
          { nodeKey: 'skip', status: 'skipped' }, { nodeKey: 'join', status: 'blocked' },
        ]) })
      wait = host.report().members.find(member => member.agentKey === 'reviewer')!.agent.waits[0]!
      expect(wait.settled).toBeNull()
    } finally { await host.shutdown() }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const coordinator = await repository.open(parseSessionId(entry.sessionId))
      const state = projectWorkflowSession(coordinator.snapshot())
      const decision = { definition: state.definition!.stored.eventId, nodeKey: 'join',
        outcome: 'skipped' as const, reason: 'required-dependency-skipped' }
      const position = coordinator.snapshot().localPosition
      await expect(new WorkflowJournal(coordinator, { now: () => Date.now() }).append(workflowNodeResolvedEventV2, () => decision))
        .rejects.toThrow('resolution-not-derived')
      expect(coordinator.snapshot().localPosition).toBe(position)
      if (mode === 'legacy') {
        await coordinator.append(workflowNodeResolvedEvent, decision)
        expect(projectWorkflowSession(coordinator.snapshot()).resolved).toContainEqual(decision)
      }
    } finally { await repository.dispose() }
    const reopened = await openHost(spec, { bindings })
    try {
      await reopened.workflow('research').resume({ requestKey: 'fanin-reopen' })
      if (mode === 'current') await reopened.submitAnswer('reviewer', wait.reference, 'Continue')
      await reopened.run()
      expect(reopened.workflow('research').report()).toMatchObject({ state: 'failed', closed: true,
        counts: { assignments: 2, accepted: mode === 'current' ? 2 : 1 } })
      expect(calls.get('writer')).toBe(1)
      expect(calls.get('reviewer')).toBe(mode === 'current' ? 2 : 1)
    } finally { await reopened.shutdown() }
    const reader = new SessionRepository({ backend: new FileSessionBackend(spec.storage),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const snapshot = await reader.read(parseSessionId(entry.sessionId))
      const decisions = snapshot.history.at(-1)!.events.filter(event => event.stored.type === workflowNodeResolvedEvent.type)
      expect(decisions.map(event => ({ node: (event.stored.payload as { nodeKey: string }).nodeKey, version: event.stored.payloadVersion })))
        .toEqual([{ node: 'skip', version: 2 }, { node: 'join', version: mode === 'legacy' ? 1 : 2 }])
      expect(projectWorkflowSession(snapshot).closed).not.toBeNull()
    } finally { await reader.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 40_000)

it('executes and reopens a null guard using accepted JSON without changing its literal value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-audit-null-'))
  try {
    const base = runnableWorkflowHost(root, '{"text":"accepted nullable data","marker":null}')
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
    const entry = base.workflows.definitions[0]!
    const definition = decodeWorkflowDefinition({ ...entry.definition, nodes: entry.definition.nodes.map(node => node.nodeKey === 'read'
      ? { ...node, output: { ...node.output, schema: { type: 'object', properties: {
        text: { type: 'string' }, marker: { type: 'null' },
      }, required: ['text', 'marker'], additionalProperties: false } } }
      : { ...node, guard: { kind: 'equals', nodeKey: 'read', path: ['marker'], value: null } }) })
    const spec = { ...base, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    await initializeHost(spec)
    const host = await openHost(spec)
    try {
      await host.workflow('research').resume({ requestKey: 'null-guard' })
      await host.run()
      expect(host.workflow('research').report()).toMatchObject({ state: 'completed', closed: true,
        counts: { assignments: 2, accepted: 2 } })
    } finally { await host.shutdown() }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const snapshot = await repository.read(parseSessionId(entry.sessionId))
      const state = projectWorkflowSession(snapshot)
      expect(state.definition!.payload.nodes[1]!.guard).toMatchObject({ value: null })
      expect(state.assignments[1]!.payload.inputs).toEqual({ text: 'accepted nullable data' })
      expect(state.decisions[0]!.payload.value).toEqual({ text: 'accepted nullable data', marker: null })
      expect(state.closed).not.toBeNull()
    } finally { await repository.dispose() }
    const reopened = await openHost(spec)
    try {
      await reopened.run()
      expect(reopened.workflow('research').report()).toMatchObject({ state: 'completed', closed: true,
        counts: { assignments: 2, accepted: 2 } })
    } finally { await reopened.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 40_000)

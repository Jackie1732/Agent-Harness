import { describe, expect, it } from 'vitest'
import { collectExperimentMetrics } from '../../src/experiment/metrics.js'
import type { SessionSnapshot } from '../../src/session/types.js'
import { createDurableEventCatalog } from '../../src/session/event-catalog.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { parseSessionId } from '../../src/session/ids.js'
import { CapabilityRegistry } from '../../src/capability/registry.js'
import { createToolDefinition, createScriptedToolExecution, ScriptedToolProvider, SessionToolRunner, ToolRegistry, toolSessionEventDefinitions } from '../../src/tool/index.js'
import { workflowAssignmentCommittedEvent, workflowDefinitionRecordedEvent } from '../../src/workflow/session-events.js'
import { workflowAssignmentMailboxDemand } from '../../src/workflow/protocol-capacity.js'
import { workflowControlRequestedEvent, workflowControlSettledEvent } from '../../src/workflow/control-events.js'
import { workflowStoppedEvent, workflowTerminalEvent, workflowClosedEvent } from '../../src/workflow/stop-events.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { workflowFixture } from '../workflow/fixtures.js'
import { childFixture } from '../subagent/child-fixture.js'
import { subagentRecoveryRequestedEvent, subagentRecoverySettledEvent } from '../../src/subagent/session-events.js'
import { agentRunStartedEvent } from '../../src/agent/session-events.js'
import { recoverAgentSession } from '../../src/agent/recovery.js'
import { clock } from '../agent/fixtures.js'

function metrics(snapshots: readonly SessionSnapshot[]) {
  return collectExperimentMetrics({ snapshots, selectedSessionIds: snapshots.map(snapshot => snapshot.header.sessionId), scope: 'unit-local/v1', mode: 'fixture',
    maxMetricSamples: 128, coverage: { complete: true, expectedSessions: snapshots.length, observedSessions: snapshots.length, reasons: [] } })
}

describe('experiment domain counters', () => {
  it('counts Tool admission, execution and cleanup separately through the real runner', async () => {
    const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
    const limits = { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096,
      maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 }
    const capabilities = new CapabilityRegistry(), scope = capabilities.scope.derive('metrics-tool'), registry = new ToolRegistry(schemaLimits)
    const repository = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 262144 }), catalog: createDurableEventCatalog(toolSessionEventDefinitions), maxLineageDepth: 0 })
    const session = await repository.create(), definition = createToolDefinition({ name: 'echo', version: 1, description: 'Echo the input.', operationClass: 'pure',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }, schemaLimits)
    const provider = new ScriptedToolProvider({ descriptor: { providerId: 'metrics-echo', adapterVersion: '1', resourceId: 'fixture', tools: [{ name: 'echo', version: 1 }],
      maxConcurrentExecutions: 1, maxArgumentsBytes: 4096, maxResultBytes: 8192 },
      acquire: plan => createScriptedToolExecution(() => ({ kind: 'success', value: plan.input }), () => undefined) })
    const registration = registry.register(scope, definition, provider), life = new AbortController()
    let decision: 'allow' | 'deny' = 'allow'
    const runner = new SessionToolRunner({ session, registry, scope, limits, policy: { policyId: 'metrics', version: 1, signal: life.signal,
      decide: () => ({ kind: decision, reasonCode: 'configured' }) } })
    try {
      await runner.invoke({ name: 'echo', input: { key: 'first' } })
      decision = 'deny'
      await runner.invoke({ name: 'echo', input: { key: 'second' } })
      const result = metrics([session.snapshot()])
      expect(result.counts['tool.requested'].value).toBe(2)
      expect(result.counts['tool.allowed'].value).toBe(1)
      expect(result.counts['tool.denied'].value).toBe(1)
      expect(result.counts['tool.started'].value).toBe(1)
      expect(result.counts['tool.executionObserved'].value).toBe(1)
      expect(result.counts['tool.settled'].value).toBe(2)
      expect(result.counts['tool.cleanupFailed'].value).toBe(0)
      expect(result.tokens.inputTokens.total).toBe(0)
    } finally { await runner.dispose(); await registration.dispose(); await registry.dispose(); await provider.dispose(); await capabilities.dispose(); await repository.dispose() }
  })

  it('counts Workflow nodes and production attempts without charging budget reservations as usage', async () => {
    const repository = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 256 * 1024 }),
      catalog: createDurableEventCatalog([workflowDefinitionRecordedEvent, workflowAssignmentCommittedEvent]), maxLineageDepth: 0 })
    try {
      const session = await repository.create({ sessionId: parseSessionId('87000000-0000-4000-8000-000000000001') })
      const recipe = workflowFixture(), definition = decodeWorkflowDefinition(recipe), recorded = await session.append(workflowDefinitionRecordedEvent, { definition: recipe })
      const node = definition.nodes[0]!, trial = node.attempts[0]!
      await session.append(workflowAssignmentCommittedEvent, { definition: recorded.stored.eventId, nodeKey: node.nodeKey, attempt: 1, kind: 'production',
        memberKey: node.executor, memberAddress: definition.roster[0]!.address, channelId: '71000000-0000-4000-8000-000000000101', inputs: {}, sourceAccepted: [],
        effectiveAllowance: trial.workerGrant, reviewerReservations: trial.reviewerGrants, toolNames: trial.toolNames, nativeActions: trial.nativeActions,
        workspace: trial.workspace, workspaceBaseline: null, protocolLimits: { maxMessageBytes: 128 * 1024, maxRecordBytes: 256 * 1024 },
        protocolReserve: workflowAssignmentMailboxDemand(definition, 'production'), deadline: new Date(Date.now() + 30000).toISOString(), acceptance: node.acceptance })
      const result = metrics([session.snapshot()])
      expect(result.counts['workflow.nodes'].value).toBe(2)
      expect(result.counts['workflow.assignments'].value).toBe(1)
      expect(result.counts['workflow.productionAttempts'].value).toBe(1)
      expect(result.counts['workflow.accepted'].value).toBe(0)
      expect(result.counts['model.prepared'].value).toBe(0)
      expect(result.tokens.outputTokens.total).toBe(0)
    } finally { await repository.dispose() }
  })

  it('distinguishes applied Workflow controls from no-op requests and durable closure', async () => {
    const repository = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 256 * 1024 }), catalog: createDurableEventCatalog([
      workflowDefinitionRecordedEvent, workflowControlRequestedEvent, workflowControlSettledEvent, workflowStoppedEvent, workflowTerminalEvent, workflowClosedEvent]), maxLineageDepth: 0 })
    try {
      const session = await repository.create({ sessionId: parseSessionId('87000000-0000-4000-8000-000000000001') })
      const recorded = await session.append(workflowDefinitionRecordedEvent, { definition: workflowFixture() })
      const pause = await session.append(workflowControlRequestedEvent, { definition: recorded.stored.eventId, requestKey: 'pause', kind: 'pause', reason: 'operator' })
      await session.append(workflowControlSettledEvent, { request: pause.stored.eventId, outcome: 'applied', owner: 'fixture' })
      const cancel = await session.append(workflowControlRequestedEvent, { definition: recorded.stored.eventId, requestKey: 'cancel', kind: 'cancel', reason: 'operator' })
      await session.append(workflowControlSettledEvent, { request: cancel.stored.eventId, outcome: 'applied', owner: 'fixture' })
      await session.append(workflowStoppedEvent, { definition: recorded.stored.eventId, reason: 'cancelled', source: cancel.stored.eventId, observedAt: new Date().toISOString() })
      const terminal = await session.append(workflowTerminalEvent, { definition: recorded.stored.eventId, outcome: 'cancelled', observedAt: new Date().toISOString() })
      await session.append(workflowClosedEvent, { terminal: terminal.stored.eventId, observedAt: new Date().toISOString() })
      const late = await session.append(workflowControlRequestedEvent, { definition: recorded.stored.eventId, requestKey: 'late-pause', kind: 'pause', reason: 'operator' })
      await session.append(workflowControlSettledEvent, { request: late.stored.eventId, outcome: 'no-op', owner: 'fixture' })
      const result = metrics([session.snapshot()])
      expect(result.counts['workflow.paused'].value).toBe(1)
      expect(result.counts['workflow.cancelled'].value).toBe(1)
      expect(result.counts['workflow.closed'].value).toBe(1)
    } finally { await repository.dispose() }
  })

  it('counts a parent delegation once and excludes the copied child grant from actual calls', async () => {
    const f = await childFixture(false)
    try {
      const result = metrics([f.parent.session.snapshot(), f.session.snapshot()])
      expect(result.counts['subagent.requested'].value).toBe(1)
      expect(result.counts['model.prepared'].value).toBe(1)
      expect(result.counts['model.settled'].value).toBe(1)
      expect(result.tokens.outputTokens).toMatchObject({ total: null, knownSubtotal: 0, eligibleCount: 1 })
      expect(result.counts['subagent.adopted'].value).toBe(0)
      expect(result.counts['subagent.closed'].value).toBe(0)
    } finally { await f.close() }
  })

  it('counts the union of nested Subagent and Agent recovery writes', async () => {
    const f = await childFixture(false)
    try {
      await f.parent.journal.append(agentRunStartedEvent, state => ({ spec: state.spec!.stored.eventId, kind: 'drive' as const }))
      const before = f.parent.session.snapshot().localPosition
      const outer = await f.parent.journal.append(subagentRecoveryRequestedEvent, (_state, snapshot) => ({ ...f.id,
        through: snapshot.localPosition, predecessorStopped: true, supersedes: null, maxWrites: 20 }))
      const lower = await recoverAgentSession(f.parent.session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 10, maxJournalConflicts: 4, clock })
      expect(lower.kind).toBe('recovered')
      await f.parent.journal.append(subagentRecoverySettledEvent, (_state, snapshot) => ({ ...f.id, recovery: outer.stored.eventId,
        writes: snapshot.localPosition - before + 1, outcome: 'complete' as const, pending: [], evidence: [] }))
      const result = metrics([f.parent.session.snapshot(), f.session.snapshot()])
      expect(result.counts['recovery.agentRequested'].value).toBe(1)
      expect(result.counts['recovery.agentSettled'].value).toBe(1)
      expect(result.counts['recovery.subagentRequested'].value).toBe(1)
      expect(result.counts['recovery.subagentSettled'].value).toBe(1)
      expect(result.counts['recovery.appendedEvents'].value).toBe(f.parent.session.snapshot().localPosition - before)
      expect(result.counts['recovery.appendedEvents'].value).toBe(5)
    } finally { await f.close() }
  })
})

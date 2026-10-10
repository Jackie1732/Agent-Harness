import { expect, it } from 'vitest'
import {
  CapabilityRegistry, ScriptedToolProvider, SessionAgent, SessionContext, SessionModelRunner, SessionToolRunner,
  ToolRegistry, communicationSessionEventDefinitions, createScriptedToolExecution, createToolDefinition,
  projectToolSession, toolSessionEventDefinitions,
} from '../../src/index.js'
import type { ModelFrame } from '../../src/index.js'
import { AgentJournal } from '../../src/agent/journal.js'
import { agentSessionEventDefinitions, agentSpecRecordedEvent } from '../../src/agent/session-events.js'
import { emptyMessageCatalog, profile, repository, runnerLimits } from '../context/fixtures.js'
import { auditProvider } from './audit-fixtures.js'
import { agentSpec, clock } from './fixtures.js'

const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
const limits = { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096,
  maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 }
type Mode = 'policy-throw' | 'prepare-throw' | 'business-error' | 'cleanup-failure'

async function toolAgent(mode: Mode) {
  const capabilities = new CapabilityRegistry(); const scope = capabilities.scope.derive('audited Tool')
  const registry = new ToolRegistry(schemaLimits)
  const definition = createToolDefinition({ name: 'echo', version: 1, description: 'Return the authorized input.', operationClass: 'pure',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }, schemaLimits)
  const trace = { models: 0, starts: 0, closes: 0, approvals: 0 }
  const provider = new ScriptedToolProvider({ descriptor: { providerId: 'audited-tool', adapterVersion: '1', resourceId: 'echo',
    tools: [{ name: 'echo', version: 1 }], maxConcurrentExecutions: 1, maxArgumentsBytes: 4096, maxResultBytes: 8192 },
    onPrepare: () => { if (mode === 'prepare-throw') throw new Error('fixture preparation failed') },
    acquire: plan => createScriptedToolExecution(() => {
      trace.starts++
      return mode === 'business-error' ? { kind: 'error', code: 'not-found' } : { kind: 'success', value: plan.input }
    }, () => { trace.closes++; if (mode === 'cleanup-failure') throw new Error('fixture close failed') }) })
  const registration = registry.register(scope, definition, provider)
  const repo = repository(undefined, [...agentSessionEventDefinitions, ...toolSessionEventDefinitions, ...communicationSessionEventDefinitions])
  const session = await repo.create()
  const modelProvider = auditProvider({ script: async function* (): AsyncGenerator<ModelFrame> {
    const intent = trace.models++ === 0
    yield { kind: 'message-start', responseId: `tool-audit-${trace.models}`, reportedModel: 'fixture-model' }
    if (intent) {
      for (let index = 0; index < 2; index++) {
        yield { kind: 'block-start', index, block: 'tool-call', callId: `echo-${index}`, name: 'echo' }
        yield { kind: 'arguments-delta', index, text: '{}' }
        yield { kind: 'block-end', index }
      }
    } else {
      yield { kind: 'block-start', index: 0, block: 'text' }
      yield { kind: 'text-delta', index: 0, text: 'done' }
      yield { kind: 'block-end', index: 0 }
    }
    yield { kind: 'complete', stopReason: intent ? 'tool-calls' : 'stop' }
  } })
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog, toolRegistry: registry })
  const recorded = await context.recordProfile(profile('generation', { toolNames: ['echo'], rendererVersion: 'context-neutral/v2' }))
  const spec = agentSpec(recorded.stored.eventId, modelProvider, { toolNames: ['echo'] })
  await new AgentJournal(session, 4, clock).append(agentSpecRecordedEvent, () => spec)
  const policyLife = new AbortController()
  const tools = new SessionToolRunner({ session, registry, scope, limits, policy: {
    policyId: 'tool-audit', version: 1, signal: policyLife.signal,
    decide: () => {
      trace.approvals++
      if (mode === 'policy-throw') throw new Error('fixture policy unavailable')
      return { kind: 'allow', reasonCode: 'fixture' }
    },
  } })
  const agent = new SessionAgent({ session, context, tools, messageCatalog: emptyMessageCatalog, clock,
    model: new SessionModelRunner({ session, provider: modelProvider, limits: runnerLimits }) })
  return { session, tools, agent, trace, async close() {
    policyLife.abort()
    for (const resource of [agent, registration, registry, provider, capabilities, modelProvider, repo]) {
      try { await resource.dispose() } catch (error) {
        if (mode !== 'cleanup-failure') throw error
        expect(error).toMatchObject({ code: expect.stringMatching(/^(AGENT|TOOL)_CLEANUP_FAILED$/) })
      }
    }
  } }
}

for (const mode of ['policy-throw', 'prepare-throw'] as const) it(`stops the current batch and Run after a faulted Tool runner: ${mode}`, async () => {
  const f = await toolAgent(mode)
  try {
    for (const text of ['first', 'second']) await f.agent.submitInput({ kind: 'task', text, originLabel: 'audit' })
    const report = await f.agent.start()
    const expectedCode = mode === 'policy-throw' ? 'TOOL_POLICY_INVALID' : 'TOOL_PROVIDER_INVALID'
    expect(f.tools.status).toBe('faulted'); expect(f.tools.failure?.code).toBe(expectedCode)
    expect(f.trace).toEqual({ models: 1, starts: 0, closes: 0, approvals: mode === 'policy-throw' ? 1 : 0 })
    expect(report.roots[0]?.outcome).toBe('failed'); expect(report.inputs.map(item => item.status)).toEqual(['review-required', 'queued'])
    expect(report.run?.settled?.payload.stoppedBy).toBe('faulted'); expect(f.agent.failure?.code).toBe('AGENT_RECOVERY_REQUIRED')
    expect(f.agent.status).toBe('faulted'); expect(f.session.status).toBe('open')
    const actions = f.agent.snapshot().actions.map(item => item.payload.result)
    expect(actions).toEqual([{ kind: 'tool', settled: expect.any(String) }, { kind: 'not-started', reason: 'prior-tool-runner-faulted' }])
    const tools = projectToolSession(f.session.snapshot())
    expect(tools.pendingInvocationId).toBeNull(); expect(tools.invocations).toHaveLength(1)
    expect(tools.invocations[0]).toMatchObject({ state: 'settled', settled: { payload: {
      outcome: 'failed', execution: 'not-started', result: { kind: 'error', code: expectedCode }, cleanup: { status: 'complete' },
    } } })
    expect(() => f.agent.start()).toThrowError(expect.objectContaining({ code: 'AGENT_INACTIVE' }))
  } finally { await f.close() }
})

it('continues ordinary Tool business errors through the configured feedback policy', async () => {
  const f = await toolAgent('business-error')
  try {
    for (const text of ['first', 'second']) await f.agent.submitInput({ kind: 'task', text, originLabel: 'audit' })
    const report = await f.agent.start()
    expect(f.tools.status).toBe('accepting'); expect(f.agent.status).toBe('accepting')
    expect(f.trace).toEqual({ models: 3, starts: 2, closes: 2, approvals: 2 })
    expect(report.roots.map(item => item.outcome)).toEqual(['completed', 'completed'])
    expect(report.inputs.map(item => item.status)).toEqual(['handled', 'handled'])
    expect(projectToolSession(f.session.snapshot()).invocations).toHaveLength(2)
  } finally { await f.close() }
})

it('keeps cleanup failure uncertain while suppressing the remaining batch and queued input', async () => {
  const f = await toolAgent('cleanup-failure')
  try {
    for (const text of ['first', 'second']) await f.agent.submitInput({ kind: 'task', text, originLabel: 'audit' })
    const report = await f.agent.start()
    expect(f.trace).toEqual({ models: 1, starts: 1, closes: 1, approvals: 1 })
    expect(report.roots[0]?.outcome).toBe('result-unknown'); expect(f.agent.failure?.code).toBe('AGENT_CLEANUP_FAILED')
    expect(report.run?.settled?.payload.stoppedBy).toBe('faulted'); expect(report.inputs.map(item => item.status)).toEqual(['review-required', 'queued'])
    expect(f.agent.snapshot().actions[1]?.payload.result).toEqual({ kind: 'not-started', reason: 'prior-result-uncertain' })
    expect(projectToolSession(f.session.snapshot()).invocations[0]).toMatchObject({ state: 'settled', settled: { payload: {
      outcome: 'succeeded', execution: 'execution-observed', cleanup: { status: 'incomplete', attempted: 1, failed: 1 },
    } } })
  } finally { await f.close() }
})

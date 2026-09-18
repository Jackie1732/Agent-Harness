import assert from 'node:assert/strict'
import { test } from 'node:test'
import { h, fixture, catalog, modelLimits } from './helpers/tool-fixture.mjs'
import { contextProfile } from '../examples/context-fixture.mjs'
import { agentSpec } from '../examples/agent-fixture.mjs'

const echo = { name: 'echo', argumentsText: '{"n":1}' }
const send = { name: 'agent_send_message', argumentsText: '{"peerKey":"missing","type":"test/request","payloadVersion":1,"payloadJson":"{}"}' }
const ask = { name: 'agent_ask_user', argumentsText: '{"question":"Continue?","timeoutMs":1000}' }
const cases = [
  { name: 'serial Tool/Model roundtrip', calls: [echo], starts: 1, outcome: 'completed' },
  { name: 'mixed Tool and native error feedback', calls: [echo, send], starts: 1, outcome: 'completed' },
  { name: 'mixed wait batch rejection', calls: [echo, ask], starts: 0, outcome: 'completed' },
  { name: 'whole-batch budget rejection', calls: [echo, echo], starts: 0, outcome: 'budget-exhausted', tools: 1 },
  { name: 'invalid original JSON feedback', calls: [{ ...echo, argumentsText: '{"n":' }], starts: 0, outcome: 'completed' },
  { name: 'Tool policy denial feedback', calls: [echo], starts: 0, outcome: 'completed', deny: true },
  { name: 'unadvertised name rejection', calls: [{ ...echo, name: 'hidden_tool' }], starts: 0, outcome: 'completed' },
  { name: 'configured business refusal is handled', calls: [echo], starts: 0, outcome: 'failed', stopReason: 'refusal', businessRefusalHandled: true },
  { name: 'unknown usage stops the next model opportunity', calls: [echo], starts: 1, outcome: 'failed', usagePolicy: 'stop-on-unknown' },
  { name: 'ordinary arguments obey Agent byte limit before Tool admission', calls: [echo], starts: 0, outcome: 'completed', maxActionBytes: 2 },
  ...['length', 'refusal', 'content-filter'].map(stopReason => ({ name: `non-actionable ${stopReason}`, calls: [echo], starts: 0, outcome: 'failed', stopReason })),
]

for (const scenario of cases) test(`Agent built: ${scenario.name}`, async () => fixture(async f => {
  let calls = 0
  const provider = new h.ScriptedModelProvider({ providerId: 'agent-built', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    script: async function* () {
      calls++
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: `result-${calls}` }
      if (calls === 1) {
        for (const [index, call] of scenario.calls.entries()) {
          yield { kind: 'block-start', index, block: 'tool-call', callId: `call-${index}`, name: call.name }
          yield { kind: 'arguments-delta', index, text: call.argumentsText }
          yield { kind: 'block-end', index }
        }
      } else {
        yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'done' }; yield { kind: 'block-end', index: 0 }
      }
      yield { kind: 'complete', stopReason: calls === 1 ? scenario.stopReason ?? 'tool-calls' : 'stop' }
    } })
  f.providers.push(provider)
  const context = new h.SessionContext({ session: f.session, messageCatalog: h.createMessageCatalog(), toolRegistry: f.registry })
  const profile = await context.recordProfile(contextProfile('generation', { rendererVersion: 'context-neutral/v2', toolNames: ['echo'] }))
  const spec = agentSpec(profile.stored.eventId, provider.descriptor, { toolNames: ['echo'], nativeActions: ['agent_send_message', 'agent_ask_user'] })
  if (scenario.tools !== undefined) spec.budget.tools = scenario.tools
  if (scenario.businessRefusalHandled) spec.businessRefusalHandled = true
  if (scenario.usagePolicy) spec.usagePolicy = scenario.usagePolicy
  if (scenario.maxActionBytes) spec.limits.maxActionBytes = scenario.maxActionBytes
  await h.installAgentSpec(f.session, spec, h.systemClock)
  const agent = new h.SessionAgent({ session: f.session, model: new h.SessionModelRunner({ session: f.session, provider, limits: modelLimits }),
    context, tools: f.runner, messageCatalog: h.createMessageCatalog(), clock: h.systemClock })
  try {
    await agent.submitInput({ kind: 'task', text: 'Execute only the configured task.', originLabel: 'built-test' })
    const result = await agent.start()
    assert.equal(result.roots[0].outcome, scenario.outcome)
    assert.equal(f.trace.starts, scenario.starts)
    if (scenario.businessRefusalHandled) assert.equal(result.inputs[0].status, 'handled')
    if (scenario.usagePolicy) {
      assert.equal(calls, 1)
      assert.equal(result.modelUsage[0].usage.completeness, 'unknown')
      assert.equal(result.modelUsage[0].usage.outputTokens, undefined)
    }
    assert.equal(f.runner.snapshot().invocations.every(item => item.requested.payload.source.kind === 'model'), true)
    for (const event of f.session.snapshot().history.at(-1).events.filter(event => event.stored.type === 'context/assembly-committed')) assert.equal(h.rebuildAssembly(f.session.snapshot(), event.stored.eventId).kind, 'rebuilt')
    if (scenario.outcome === 'completed') {
      assert.equal(result.final.text, 'done')
      const assembly = f.session.snapshot().history.at(-1).events.filter(event => event.stored.type === 'context/assembly-committed').at(-1)
      const request = h.rebuildAssembly(f.session.snapshot(), assembly.stored.eventId).request
      for (const create of [h.createDeepSeekModelProvider, h.createAnthropicModelProvider]) {
        const adapter = create({ providerId: 'offline-prepare', endpoint: 'https://example.invalid/model', apiKey: 'offline-placeholder', maxConcurrentExchanges: 1,
          streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 } })
        try {
          if (scenario.name === 'invalid original JSON feedback' && create === h.createAnthropicModelProvider) assert.throws(() => adapter.prepare(request), error => error.code === 'MODEL_FEATURE_UNSUPPORTED')
          else assert.ok(adapter.prepare(request).submission)
        } finally { await adapter.dispose() }
      }
      const decision = agent.snapshot().steps[0].decided
      const exchange = h.agentActionHistory(f.session.snapshot(), decision.stored.eventId)
      assert.equal(exchange[0].content.length, scenario.calls.length)
      assert.equal(exchange[1].content.length, scenario.calls.length)
      for (const [i, call] of scenario.calls.entries()) assert.equal(exchange[0].content[i].argumentsText, call.argumentsText)
    }
  } finally { await agent.dispose() }
}, { catalog: catalog([...h.contextSessionEventDefinitions, ...h.communicationSessionEventDefinitions, ...h.agentSessionEventDefinitions]),
  decide: scenario.deny ? () => ({ kind: 'deny', reasonCode: 'test-denial' }) : undefined }))


test('Agent built: Tool cleanup failure stops the Run before the next queued input', async () => fixture(async f => {
  let calls = 0
  const provider = new h.ScriptedModelProvider({ providerId: 'agent-cleanup', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    script: async function* () {
      calls++
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'tool' }
      yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'echo', name: 'echo' }
      yield { kind: 'arguments-delta', index: 0, text: '{"n":1}' }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
    } })
  f.providers.push(provider)
  const context = new h.SessionContext({ session: f.session, messageCatalog: h.createMessageCatalog(), toolRegistry: f.registry })
  const profile = await context.recordProfile(contextProfile('generation', { rendererVersion: 'context-neutral/v2', toolNames: ['echo'] }))
  await h.installAgentSpec(f.session, agentSpec(profile.stored.eventId, provider.descriptor, { toolNames: ['echo'] }), h.systemClock)
  const agent = new h.SessionAgent({ session: f.session, model: new h.SessionModelRunner({ session: f.session, provider, limits: modelLimits }),
    context, tools: f.runner, messageCatalog: h.createMessageCatalog(), clock: h.systemClock })
  try {
    for (const text of ['first', 'second']) await agent.submitInput({ kind: 'task', text, originLabel: 'built-audit' })
    const result = await agent.start()
    assert.equal(calls, 1); assert.equal(f.trace.starts, 1); assert.equal(f.trace.closes, 1)
    assert.equal(result.run.settled.payload.stoppedBy, 'faulted')
    assert.equal(result.roots[0].outcome, 'result-unknown')
    assert.deepEqual(result.inputs.map(item => item.status), ['review-required', 'queued'])
    assert.equal(agent.failure.code, 'AGENT_CLEANUP_FAILED')
    const settlement = f.runner.snapshot().invocations[0].settled.payload
    assert.notEqual(settlement.cleanup.status, 'complete')
    assert.equal(settlement.execution, 'execution-observed')
  } finally { await agent.dispose().catch(() => undefined) }
}, { catalog: catalog([...h.contextSessionEventDefinitions, ...h.communicationSessionEventDefinitions, ...h.agentSessionEventDefinitions]),
  close: () => { throw new Error('owned resource release failed') }, allowCleanupFailure: true }))

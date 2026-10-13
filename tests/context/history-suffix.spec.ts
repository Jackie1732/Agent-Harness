import { expect, it } from 'vitest'
import {
  CapabilityRegistry,
  ScriptedModelProvider,
  SessionContext,
  SessionModelRunner,
  SessionToolRunner,
  ToolRegistry,
  assembleContext,
  createDeepSeekModelProvider,
  createToolDefinition,
  describeToolForModel,
  toolSessionEventDefinitions,
} from '../../src/index.js'
import type { ContextBudgetLimits, ContextBuildResult, ContextCapturedFacts, ModelRequest } from '../../src/index.js'
import { inspectBoundedJson } from '../../src/schema/bounded-json.js'
import { emptyMessageCatalog, profile, repository, runnerLimits, scriptedModel, selection } from './fixtures.js'
import { httpFixture, sse, streamLimits } from '../model/fixtures.js'

const current = 'current task'
const emptyCaptured: ContextCapturedFacts = { tools: [], messageSupport: [] }

function request(texts: readonly string[], captured = emptyCaptured): ModelRequest {
  return { model: 'fixture-model', instructions: ['Answer precisely.'], tools: captured.tools.map(tool => tool.model),
    messages: texts.map(text => ({ role: 'user', content: [{ kind: 'text', text }] })), maxOutputTokens: 256 }
}

function ready(result: ContextBuildResult) {
  expect(result.kind).toBe('ready')
  if (result.kind !== 'ready') throw new Error('expected a ready Context assembly')
  return result
}

async function fixture(texts: readonly string[], budget: Partial<ContextBudgetLimits> = {}, captured = emptyCaptured) {
  const repo = repository()
  const provider = scriptedModel()
  const session = await repo.create()
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
  const base = profile()
  const recorded = await context.recordProfile(profile('generation', { toolNames: captured.tools.map(tool => tool.definition.name), budget: { ...base.budget, ...budget } }))
  const inputs = []
  for (const text of [...texts, current]) inputs.push(await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'suffix', text }))
  const input = inputs.at(-1)!
  const options = selection(recorded.stored.eventId, provider.descriptor, { requiredInputs: [{ eventId: input.stored.eventId, selector: 'user-input' }] })
  return { session, context, recorded, inputs, options,
    build: () => assembleContext({ snapshot: session.snapshot(), profile: recorded, selection: options, captured, sessionMaxRecordBytes: session.maxRecordBytes }),
    close: async () => { await context.dispose(); await provider.dispose(); await repo.dispose() } }
}

it.each([0, 1, 9])('retains all %i optional units when the complete suffix fits', async count => {
  const texts = Array.from({ length: count }, (_, index) => `observation-${index}`)
  const f = await fixture(texts)
  try {
    const result = ready(f.build())
    expect(result.request).toEqual(request([...texts, current]))
    expect(result.assembly.selected.map(item => item.reference.eventId)).toEqual(f.inputs.map(input => input.stored.eventId))
    expect(result.assembly.omitted).toEqual([{ reference: { eventId: f.inputs.at(-1)!.stored.eventId, selector: 'user-input' }, reason: 'required-duplicate' }])
    expect(result.assembly.budget.requestBytes).toBe(Buffer.byteLength(JSON.stringify(result.request)))
  } finally { await f.close() }
})

it.each([0, -1])('selects the newest unit at the exact byte threshold with a %i-byte adjustment', async adjustment => {
  const expected = request(['newest', current])
  const f = await fixture(['newest'], { maxRequestBytes: Buffer.byteLength(JSON.stringify(expected)) + adjustment })
  try {
    const result = ready(f.build())
    expect(result.request).toEqual(adjustment === 0 ? expected : request([current]))
    expect(result.assembly.omitted.slice(1)).toEqual(adjustment === 0 ? [] : [
      { reference: { eventId: f.inputs[0]!.stored.eventId, selector: 'user-input' }, reason: 'history-budget' },
    ])
  } finally { await f.close() }
})

it('stops at the first oversized unit and preserves the newest-to-oldest omission order', async () => {
  const texts = ['tiny-old', 'tiny-middle', 'oversized-'.repeat(100), 'newest']
  const f = await fixture(texts, { maxRequestBytes: Buffer.byteLength(JSON.stringify(request(['newest', current]))) })
  try {
    const result = ready(f.build())
    expect(result.request).toEqual(request(['newest', current]))
    expect(result.assembly.omitted.slice(1)).toEqual([2, 1, 0].map((index, ordinal) => ({
      reference: { eventId: f.inputs[index]!.stored.eventId, selector: 'user-input' }, reason: ordinal === 0 ? 'history-budget' : 'outside-suffix',
    })))
  } finally { await f.close() }
})

it('uses the complete neutral token estimate at an exact history boundary', async () => {
  const expected = request(['second', 'newest', current])
  const estimated = Math.ceil(Buffer.byteLength(JSON.stringify(expected)) / 4) + 8
  const f = await fixture(['older', 'second', 'newest'], { contextWindowTokens: estimated + 4096 + 256 })
  try {
    const result = ready(f.build())
    expect(result.request).toEqual(expected)
    expect(result.assembly.budget.estimatedInputTokens).toBe(estimated)
    expect(result.assembly.omitted.at(-1)).toEqual({ reference: { eventId: f.inputs[0]!.stored.eventId, selector: 'user-input' }, reason: 'history-budget' })
  } finally { await f.close() }
})

function schemaSurface(): ContextCapturedFacts {
  const definition = createToolDefinition({ name: 'lookup', version: 1, description: 'Inspect a structured observation', operationClass: 'read-only',
    inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field${index}`, { type: 'string' }])), additionalProperties: false },
    outputSchema: { type: 'string' } }, { maxSchemaBytes: 65_536, maxSchemaDepth: 16, maxSchemaNodes: 4096 })
  return { tools: [{ definition, provider: { providerId: 'suffix-tool', adapterVersion: '1', resourceId: 'fixture',
    tools: [{ name: definition.name, version: 1 }], maxConcurrentExecutions: 1, maxArgumentsBytes: 4096, maxResultBytes: 4096 }, model: describeToolForModel(definition) }], messageSupport: [] }
}

function nodes(value: ModelRequest): number {
  return inspectBoundedJson(value, { maxBytes: 16 * 1024 * 1024, maxDepth: 64, maxNodes: 250_000 }).nodes
}

it('returns the first JSON resource failure without changing it into a history omission', async () => {
  const captured = schemaSurface()
  const maximum = nodes(request(['newest', current], captured)) - 1
  const f = await fixture(['older', 'newest'], { maxJsonNodes: maximum }, captured)
  try { expect(f.build()).toEqual({ kind: 'resource-limit', limit: 'json', maximum }) }
  finally { await f.close() }
})

it('preserves the later report limit after a history byte stop preceding a farther JSON failure', async () => {
  const captured = schemaSurface()
  const maximum = nodes(request(['older', 'second', 'newest', current], captured))
  const f = await fixture(['oldest', 'older', 'second', 'newest'], {
    maxRequestBytes: Buffer.byteLength(JSON.stringify(request(['second', 'newest', current], captured))), maxJsonNodes: maximum,
  }, captured)
  try { expect(f.build()).toEqual({ kind: 'resource-limit', limit: 'report', maximum }) }
  finally { await f.close() }
})

it('keeps pinned compaction placement and required duplicate omissions unchanged', async () => {
  const f = await fixture(['older source '.repeat(1000), 'newer source '.repeat(1000), 'optional'])
  try {
    const compaction = await f.context.compact({ profileEventId: f.recorded.stored.eventId,
      history: { mode: 'local-suffix', representation: 'raw' }, units: f.inputs.slice(0, 2).map(input => ({ eventId: input.stored.eventId, selector: 'user-input' })),
      protectedRefs: [], maxExcerptBytes: 16 })
    expect(compaction.kind).toBe('committed')
    if (compaction.kind !== 'committed') throw new Error('expected a beneficial pinned compaction')
    const result = ready(assembleContext({ snapshot: f.session.snapshot(), profile: f.recorded, selection: { ...f.options, compactions: [compaction.committed.stored.eventId] },
      captured: emptyCaptured, sessionMaxRecordBytes: f.session.maxRecordBytes }))
    expect(result.assembly.selected.map(item => item.reference.eventId)).toEqual([compaction.committed.stored.eventId, f.inputs[2]!.stored.eventId, f.inputs[3]!.stored.eventId])
    expect(result.assembly.omitted).toEqual([
      ...f.inputs.slice(0, 2).map(input => ({ reference: { eventId: input.stored.eventId, selector: 'user-input' }, reason: 'compacted' })),
      { reference: { eventId: f.inputs[3]!.stored.eventId, selector: 'user-input' }, reason: 'required-duplicate' },
    ])
  } finally { await f.close() }
})

it('selects complete Tool exchanges and keeps continuation compatibility after suffix selection', async () => {
  const chunk = (delta: object, finish: string | null = null) => sse('', { id: 'suffix-continuation', object: 'chat.completion.chunk', created: 1,
    model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })
  const http = await httpFixture(response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(chunk({ reasoning_content: 'thought '.repeat(300) }) + chunk({ content: 'answer' }, 'stop') + sse('', '[DONE]'))
  })
  const provider = createDeepSeekModelProvider({ providerId: 'suffix-model', endpoint: http.endpoint, apiKey: 'fixture-key', maxConcurrentExchanges: 1, streamLimits })
  const other = new ScriptedModelProvider({ providerId: 'suffix-tools', maxConcurrentExchanges: 1, streamLimits, script: async function* () {
    yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'suffix-tool' }
    yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'lookup-1', name: 'lookup' }
    yield { kind: 'arguments-delta', index: 0, text: '{"query":' }
    yield { kind: 'block-end', index: 0 }
    yield { kind: 'complete', stopReason: 'tool-calls' }
  } })
  const repo = repository(undefined, toolSessionEventDefinitions)
  const session = await repo.create()
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
  const model = new SessionModelRunner({ session, provider, limits: runnerLimits })
  const otherModel = new SessionModelRunner({ session, provider: other, limits: runnerLimits })
  const capabilities = new CapabilityRegistry()
  const scope = capabilities.scope.derive('suffix history')
  const registry = new ToolRegistry({ maxSchemaBytes: 16_384, maxSchemaDepth: 16, maxSchemaNodes: 512 })
  const tools = new SessionToolRunner({ session, scope, registry, limits: { maxSchemaBytes: 16_384, maxSchemaDepth: 16, maxSchemaNodes: 512,
    maxRequestBytes: 65_536, maxPlanBytes: 65_536, maxArgumentsBytes: 4096, maxJsonDepth: 16, maxJsonNodes: 4096, maxResultBytes: 4096, maxJournalConflicts: 4 },
    policy: { policyId: 'suffix', version: 1, signal: new AbortController().signal, decide: () => ({ kind: 'allow', reasonCode: 'fixture' }) } })
  try {
    const recorded = await context.recordProfile(profile())
    await model.invoke({ ...request(['think']), profile: { namespace: 'deepseek.chat', version: 1, options: { thinking: 'enabled' } } })
    const called = await otherModel.invoke({ ...request(['lookup']), tools: [{ name: 'lookup', description: 'Look up a value', inputSchema: { type: 'object' } }] })
    await tools.invokeModelIntent({ invocationId: called.payload.invocationId, outputBlockIndex: 0 })
    const input = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'suffix', text: current })
    const options = selection(recorded.stored.eventId, provider.descriptor, { requiredInputs: [{ eventId: input.stored.eventId, selector: 'user-input' }] })
    const build = (selected: typeof options, selectedProfile = recorded) => assembleContext({ snapshot: session.snapshot(), profile: selectedProfile,
      selection: selected, captured: emptyCaptured, sessionMaxRecordBytes: session.maxRecordBytes })
    const raw = ready(build(options))
    expect(raw.request.messages.map(message => message.role)).toEqual(['assistant', 'assistant', 'user', 'user'])
    expect(raw.request.messages[0]!.role === 'assistant' && raw.request.messages[0]!.continuation?.text).toBe('thought '.repeat(300))
    expect(raw.request.messages[1]!.content[0]!.kind).toBe('tool-call')
    expect(raw.request.messages[2]!.content[0]!.kind).toBe('tool-result')
    const mismatch = { ...options, target: { ...options.target, provider: other.descriptor } }
    expect(build(mismatch)).toMatchObject({ kind: 'blocked', reason: 'history-unrepresentable' })
    const note = ready(build({ ...mismatch, history: { mode: 'local-suffix', representation: 'historical-note/v1' } }))
    expect(note.request.messages).toHaveLength(3)
    expect(JSON.stringify(note.request)).not.toContain('thought '.repeat(300))
    const narrowed = await context.recordProfile({ ...recorded.payload, previousEventId: recorded.stored.eventId,
      budget: { ...recorded.payload.budget, maxRequestBytes: Buffer.byteLength(JSON.stringify(request([current]))) } })
    const limited = ready(build({ ...mismatch, profileEventId: narrowed.stored.eventId }, narrowed))
    expect(limited.request).toEqual(request([current]))
    expect(limited.assembly.omitted.slice(-2).map(item => item.reason)).toEqual(['history-budget', 'outside-suffix'])
    expect(http.requests).toHaveLength(1)
  } finally {
    await tools.dispose(); await otherModel.dispose(); await model.dispose(); await context.dispose()
    await registry.dispose(); await scope.dispose(); await capabilities.dispose()
    await other.dispose(); await provider.dispose(); await repo.dispose(); await http.close()
  }
})

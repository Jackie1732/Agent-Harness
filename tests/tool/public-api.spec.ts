import { describe, expect, it } from 'vitest'
import * as api from '../../src/index.js'
import { validateToolSchema } from '../../src/model/tool-schema.js'

const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
const limits = { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096,
  maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 }

describe('Step 7 source public entry', () => {
  it('T7-03 keeps journals, execution tickets, native I/O and schema compilers private', () => {
    for (const name of ['ToolJournal', 'borrowTool', 'ToolExecutionPool', 'compileDefinition', 'createWorkspaceReadTextProviderWithIO']) {
      expect(Object.hasOwn(api, name)).toBe(false)
    }
    expect(api.toolSessionEventDefinitions).toHaveLength(4)
    expect(api.toolSessionEventDefinitions.every(event => event.ignorable === false)).toBe(true)
  })
  it('T7-02/03/35 runs a direct call through the source API without a Model Provider', async () => {
    const capabilities = new api.CapabilityRegistry(), scope = capabilities.scope.derive('source-test')
    const registry = new api.ToolRegistry(schemaLimits)
    const repository = new api.SessionRepository({ backend: new api.MemorySessionBackend({ maxRecordBytes: 262144 }),
      catalog: api.createDurableEventCatalog(api.toolSessionEventDefinitions), maxLineageDepth: 0 })
    const session = await repository.create()
    const definition = api.createToolDefinition({ name: 'echo', version: 1, description: 'Return input.', operationClass: 'pure',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }, schemaLimits)
    let started = 0, closed = 0
    const provider = new api.ScriptedToolProvider({ descriptor: { providerId: 'source-echo', adapterVersion: '1', resourceId: 'research',
      tools: [{ name: 'echo', version: 1 }], maxConcurrentExecutions: 1, maxArgumentsBytes: 4096, maxResultBytes: 8192 },
      acquire: plan => api.createScriptedToolExecution(() => { started++; return { kind: 'success', value: plan.input } }, () => { closed++ }) })
    const registration = registry.register(scope, definition, provider)
    const policyLife = new AbortController()
    const runner = new api.SessionToolRunner({ session, registry, scope, limits,
      policy: { policyId: 'source-test', version: 1, signal: policyLife.signal, decide: () => ({ kind: 'allow', reasonCode: 'test' }) } })
    try {
      const result = await runner.invoke({ name: 'echo', input: { value: 'stable' } })
      expect(result.payload.outcome).toBe('succeeded')
      expect(result.payload.result).toEqual({ kind: 'success', value: { value: 'stable' } })
      expect(started).toBe(1); expect(closed).toBe(1)
      expect(session.snapshot().history.at(-1)?.events).toHaveLength(4)
    } finally {
      await runner.dispose(); await registration.dispose(); await registry.dispose(); await provider.dispose()
      await capabilities.dispose(); await repository.dispose()
    }
  })
  it('T7-10 preserves the Model input-only root restriction but allows non-object tool output', () => {
    expect(() => validateToolSchema({ type: 'string' })).toThrowError()
    expect(() => validateToolSchema({ type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] })).not.toThrow()
    expect(() => validateToolSchema({ type: 'object', $ref: 'external' })).toThrowError()
    const definition = api.createToolDefinition({ name: 'text', version: 1, description: 'Produce text.', operationClass: 'pure',
      inputSchema: { type: 'object' }, outputSchema: { type: 'string' } }, schemaLimits)
    expect(definition.outputSchema.type).toBe('string')
    expect(api.describeToolForModel(definition)).toEqual({ name: 'text', description: 'Produce text.', inputSchema: { type: 'object' } })
  })
  it('T7-06 applies the explicit Tool schema depth while Model keeps its existing ceiling', () => {
    let output: api.JsonObject = { type: 'integer' }
    for (let depth = 0; depth < 33; depth++) output = { type: 'array', items: output }
    expect(() => api.createToolDefinition({ name: 'deep', version: 1, description: 'Deep output.', operationClass: 'pure',
      inputSchema: { type: 'object' }, outputSchema: output }, { ...schemaLimits, maxSchemaDepth: 40 })).not.toThrow()
    expect(() => api.createToolDefinition({ name: 'deep', version: 1, description: 'Deep output.', operationClass: 'pure',
      inputSchema: { type: 'object' }, outputSchema: output }, schemaLimits)).toThrowError()
    expect(() => validateToolSchema({ type: 'object', properties: { value: output } })).toThrowError()
  })
})

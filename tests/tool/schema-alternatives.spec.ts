import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as api from '../../src/index.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { resolveWorkflowNode } from '../../src/workflow/graph.js'
import { workflowFixture } from '../workflow/fixtures.js'

const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
const limits = { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096,
  maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 }
const literal = (kind: string): api.JsonObject => ({ type: 'object',
  properties: { kind: { type: 'string', enum: [kind] } }, required: ['kind'], additionalProperties: false })
const alternatives: api.JsonObject = { type: 'object', oneOf: [literal('first'), literal('second')] }
const overlapping: api.JsonObject = { type: 'object', oneOf: [{ type: 'object' }, literal('first')] }

interface Pipeline {
  readonly session: api.SessionHandle
  readonly runner: api.SessionToolRunner
  readonly trace: { approvals: number; starts: number; closes: number }
}

async function withPipeline(inputSchema: api.JsonObject, outputSchema: api.JsonObject,
  body: (pipeline: Pipeline) => Promise<void>, options: { root?: string; output?: api.JsonValue } = {}): Promise<void> {
  const capabilities = new api.CapabilityRegistry(), scope = capabilities.scope.derive('schema alternatives')
  const registry = new api.ToolRegistry(schemaLimits)
  const backend = options.root === undefined ? new api.MemorySessionBackend({ maxRecordBytes: 262144 })
    : new api.FileSessionBackend({ root: options.root, maxRecordBytes: 262144 })
  const repository = new api.SessionRepository({ backend,
    catalog: api.createDurableEventCatalog(api.toolSessionEventDefinitions), maxLineageDepth: 0 })
  const session = await repository.create()
  const definition = api.createToolDefinition({ name: 'schema_echo', version: 1, description: 'Return the authorized JSON.',
    operationClass: 'pure', inputSchema, outputSchema }, schemaLimits)
  const trace = { approvals: 0, starts: 0, closes: 0 }
  const provider = new api.ScriptedToolProvider({ descriptor: { providerId: 'schema-echo', adapterVersion: '1', resourceId: 'local',
    tools: [{ name: definition.name, version: definition.version }], maxConcurrentExecutions: 1,
    maxArgumentsBytes: 4096, maxResultBytes: 8192 },
  acquire: plan => api.createScriptedToolExecution(() => {
    trace.starts++
    return { kind: 'success', value: options.output ?? plan.input }
  }, () => { trace.closes++ }) })
  const registration = registry.register(scope, definition, provider)
  const runner = new api.SessionToolRunner({ session, registry, scope, limits,
    policy: { policyId: 'schema-test', version: 1, signal: new AbortController().signal,
      decide: () => { trace.approvals++; return { kind: 'allow', reasonCode: 'test' } } } })
  try { await body({ session, runner, trace }) }
  finally {
    await runner.dispose(); await registration.dispose(); await registry.dispose(); await provider.dispose()
    await capabilities.dispose(); await repository.dispose()
  }
}

describe('supported Schema alternatives across Tool and Workflow', () => {
  it('accepts one branch through authorization, execution, output validation and independent File replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tool-schema-alternatives-'))
    let id!: api.SessionId, expected!: api.ToolSessionSnapshot
    try {
      await withPipeline(alternatives, alternatives, async ({ runner, session, trace }) => {
        id = session.header.sessionId
        for (const kind of ['first', 'second']) {
          const result = await runner.invoke({ name: 'schema_echo', input: { kind } })
          expect(result.payload.outcome).toBe('succeeded')
          expect(result.payload.result).toEqual({ kind: 'success', value: { kind } })
        }
        expect(trace).toEqual({ approvals: 2, starts: 2, closes: 2 })
        expected = api.projectToolSession(session.snapshot())
        expect(expected.invocations).toHaveLength(2)
      }, { root })
      const repository = new api.SessionRepository({ backend: new api.FileSessionBackend({ root, maxRecordBytes: 262144 }),
        catalog: api.createDurableEventCatalog(api.toolSessionEventDefinitions), maxLineageDepth: 0 })
      try { expect(api.projectToolSession(await repository.read(id))).toEqual(expected) }
      finally { await repository.dispose() }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  for (const [name, schema, input] of [
    ['no matching branch', alternatives, { kind: 'other' }],
    ['two matching branches', overlapping, { kind: 'first' }],
  ] as const) {
    it(`rejects ${name} before Policy or Provider execution`, async () => {
      await withPipeline(schema, { type: 'object' }, async ({ runner, session, trace }) => {
        const result = await runner.invoke({ name: 'schema_echo', input })
        expect(result.payload.outcome).toBe('rejected')
        expect(result.payload.result).toEqual({ kind: 'error', code: 'invalid-arguments' })
        expect(trace).toEqual({ approvals: 0, starts: 0, closes: 0 })
        expect(api.projectToolSession(session.snapshot()).pendingInvocationId).toBeNull()
      })
    })
  }

  it('records an ambiguous output as a failed execution and replays that actual failure', async () => {
    await withPipeline({ type: 'object' }, overlapping, async ({ runner, session, trace }) => {
      const result = await runner.invoke({ name: 'schema_echo', input: {} })
      expect(result.payload.outcome).toBe('failed')
      expect(result.payload.result).toEqual({ kind: 'error', code: 'TOOL_RESULT_INVALID' })
      expect(result.payload.execution).toBe('execution-observed')
      expect(trace).toEqual({ approvals: 1, starts: 1, closes: 1 })
      const invocation = api.projectToolSession(session.snapshot()).invocations[0]!
      expect(invocation.state).toBe('settled')
      if (invocation.state === 'settled') expect(invocation.settled).toEqual(result)
    }, { output: { kind: 'first' } })
  })

  it('retains nested alternatives, array items and special JSON keys in enum values', async () => {
    const special = JSON.parse('{"__proto__":{"n":1},"constructor":"data"}') as api.JsonObject
    const branch: api.JsonObject = { type: 'object',
      properties: { kind: { type: 'string', enum: ['special'] }, data: { type: 'object', enum: [special] } },
      required: ['kind', 'data'], additionalProperties: false }
    const schema: api.JsonObject = { type: 'object', properties: { values: { type: 'array',
      items: { type: 'object', oneOf: [branch, literal('empty')] } } }, required: ['values'], additionalProperties: false }
    const input = { values: [{ kind: 'special', data: special }, { kind: 'empty' }] }
    const original = structuredClone(input)
    await withPipeline(schema, schema, async ({ runner, trace }) => {
      const result = await runner.invoke({ name: 'schema_echo', input })
      expect(result.payload.outcome).toBe('succeeded')
      expect(result.payload.result).toEqual({ kind: 'success', value: original })
      expect(trace).toEqual({ approvals: 1, starts: 1, closes: 1 })
    })
    expect(input).toEqual(original)
    expect(Object.hasOwn(special, '__proto__')).toBe(true)
    expect(Object.hasOwn(Object.prototype, 'n')).toBe(false)
  })

  for (const workspace of [
    { kind: 'none' },
    { kind: 'shared-read', resourceId: 'files', readFiles: ['paper.txt'], writePrefixes: [] },
    { kind: 'exclusive-write', resourceId: 'files', readFiles: [], writePrefixes: ['results'] },
  ] as const) {
    it(`uses the actual Subagent ${workspace.kind} description through the Tool pipeline`, async () => {
      const surface = api.agentNativeToolDefinitions(['agent_spawn_subagent'])[0]!
      const input = { templateKey: 'research', templateVersion: 1, task: 'Inspect assigned material.', materials: [],
        requestedBudget: { models: 1, steps: 1, tools: 0, messages: 1, waits: 1, outputTokens: 128 }, workspace }
      await withPipeline(surface.inputSchema, surface.inputSchema, async ({ runner, trace }) => {
        const result = await runner.invoke({ name: 'schema_echo', input })
        expect(result.payload.outcome).toBe('succeeded')
        expect(result.payload.result).toEqual({ kind: 'success', value: input })
        expect(trace).toEqual({ approvals: 1, starts: 1, closes: 1 })
      })
    })
  }

  it('resolves a real Workflow input using the Subagent workspace alternatives', () => {
    const fixture = workflowFixture()
    const surface = api.agentNativeToolDefinitions(['agent_spawn_subagent'])[0]!
    const workspaceSchema = (surface.inputSchema.properties as api.JsonObject).workspace!
    const schema = { type: 'object', properties: { workspace: workspaceSchema }, required: ['workspace'], additionalProperties: false }
    const node = { ...fixture.nodes[0]!, inputSchema: schema,
      inputs: [{ name: 'workspace', source: { kind: 'literal', value: { kind: 'none' } } }] }
    const definition = decodeWorkflowDefinition({ ...fixture, nodes: [node, fixture.nodes[1]!] })
    expect(resolveWorkflowNode(definition.nodes[0]!, new Map(), definition))
      .toEqual({ kind: 'ready', inputs: { workspace: { kind: 'none' } } })
  })
})

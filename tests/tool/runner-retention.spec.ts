import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import { CapabilityRegistry } from '../../src/capability/registry.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { createDurableEventCatalog } from '../../src/session/event-catalog.js'
import { createToolDefinition } from '../../src/tool/definition.js'
import { ToolRegistry } from '../../src/tool/registry.js'
import { SessionToolRunner } from '../../src/tool/runner.js'
import { parseModelInvocationId } from '../../src/model/ids.js'
import { parseToolInvocationId } from '../../src/tool/ids.js'
import { toolSessionEventDefinitions } from '../../src/tool/session-events.js'
import { ScriptedToolProvider, createScriptedToolExecution } from '../../src/tool/providers/scripted.js'

const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
const limits = { ...schemaLimits,
  maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096,
  maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 }

async function retire(invoke: boolean, cleanupFails: boolean) {
  const capabilities = new CapabilityRegistry(), scope = capabilities.scope.derive('runner retirement')
  const registry = new ToolRegistry(schemaLimits)
  const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 262144 }),
    catalog: createDurableEventCatalog(toolSessionEventDefinitions), maxLineageDepth: 0 })
  const session = await repo.create(), life = new AbortController()
  const policy = { policyId: 'retirement', version: 1, signal: life.signal,
    decide: () => ({ kind: 'allow' as const, reasonCode: 'test' }) }
  const identity = { nextInvocationId: () => parseToolInvocationId('11111111-1111-4111-8111-111111111111') }
  const definition = createToolDefinition({ name: 'echo', version: 1, description: 'Return input.', operationClass: 'pure',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }, schemaLimits)
  const provider = new ScriptedToolProvider({ descriptor: { providerId: 'retirement', adapterVersion: '1', resourceId: 'local',
    tools: [{ name: 'echo', version: 1 }], maxConcurrentExecutions: 1, maxArgumentsBytes: 4096, maxResultBytes: 8192 },
    acquire: plan => createScriptedToolExecution(() => ({ kind: 'success', value: plan.input }), () => {
      if (cleanupFails) throw new Error('private cleanup failure')
    }) })
  const registration = registry.register(scope, definition, provider)
  const runner = new SessionToolRunner({ session, scope, registry, policy, identity, limits })
  if (invoke) {
    if (cleanupFails) await assert.rejects(runner.invoke({ name: 'echo', input: {} }), { code: 'TOOL_CLEANUP_FAILED' })
    else await runner.invoke({ name: 'echo', input: {} })
  }
  const snapshot = runner.snapshot()
  const refs = { session: new WeakRef(session), scope: new WeakRef(scope), registry: new WeakRef(registry),
    policy: new WeakRef(policy), identity: new WeakRef(identity), signal: new WeakRef(life.signal) }
  const close = runner.dispose()
  if (cleanupFails) await assert.rejects(close, { code: 'TOOL_CLEANUP_FAILED' })
  else await close
  expect(session.status).toBe('open')
  for (const resource of [registration, registry, provider, capabilities, repo]) await resource.dispose().catch(() => undefined)
  return { runner, snapshot, close, refs }
}

it.each([[false, false], [true, false], [true, true]])('retires borrowed Tool runtime: invocation=%s, cleanup failure=%s', async (invoke, fails) => {
  const { runner, snapshot, close, refs } = await retire(invoke, fails)
  await setImmediate()
  queryObjects(SessionToolRunner, { format: 'count' })
  expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined]))).toEqual({
    session: false, scope: false, registry: false, policy: false, identity: false, signal: false,
  })
  expect(runner.status).toBe('disposed')
  expect(runner.dispose()).toBe(close)
  expect(() => runner.invoke({ name: 'echo', input: {} })).toThrowError(expect.objectContaining({ code: 'TOOL_RUNNER_INACTIVE' }))
  expect(() => runner.invokeModelIntent({ invocationId: parseModelInvocationId('11111111-1111-4111-8111-111111111111'), outputBlockIndex: 0 })).toThrowError(expect.objectContaining({ code: 'TOOL_RUNNER_INACTIVE' }))
  expect(() => runner.snapshot()).toThrowError(expect.objectContaining({ code: 'TOOL_RUNNER_INACTIVE' }))
  expect(Object.isFrozen(snapshot)).toBe(true)
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it.each([false, true])('keeps Tool runtime until close and durable settlement, failed cleanup=%s', async fails => {
  const capabilities = new CapabilityRegistry(), scope = capabilities.scope.derive('tool close barrier')
  const registry = new ToolRegistry(schemaLimits)
  const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 262144 }),
    catalog: createDurableEventCatalog(toolSessionEventDefinitions), maxLineageDepth: 0 })
  const session = await repo.create(), closing = deferred(), release = deferred()
  const definition = createToolDefinition({ name: 'echo', version: 1, description: 'Return input.', operationClass: 'pure',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }, schemaLimits)
  const provider = new ScriptedToolProvider({ descriptor: { providerId: 'barrier', adapterVersion: '1', resourceId: 'local',
    tools: [{ name: 'echo', version: 1 }], maxConcurrentExecutions: 1, maxArgumentsBytes: 4096, maxResultBytes: 8192 },
    acquire: plan => createScriptedToolExecution(() => ({ kind: 'success', value: plan.input }), async () => {
      closing.resolve(); await release.promise
      if (fails) throw new Error('private cleanup failure')
    }) })
  const registration = registry.register(scope, definition, provider)
  const runner = new SessionToolRunner({ session, scope, registry, limits,
    policy: { policyId: 'barrier', version: 1, signal: new AbortController().signal,
      decide: () => ({ kind: 'allow', reasonCode: 'test' }) } })
  const pending = runner.invoke({ name: 'echo', input: {} })
  void pending.catch(() => undefined)
  try {
    await closing.promise
    const close = runner.dispose(); let disposed = false
    void close.then(() => { disposed = true }, () => { disposed = true })
    expect(runner.dispose()).toBe(close)
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(runner.status).toBe('disposing')
    expect(runner.snapshot().invocations[0]?.state).toBe('started')
    expect(session.snapshot().localPosition).toBe(3)
    release.resolve()
    if (fails) {
      await assert.rejects(pending, { code: 'TOOL_CLEANUP_FAILED' })
      await assert.rejects(close, { code: 'TOOL_CLEANUP_FAILED' })
    } else { await pending; await close }
    expect(session.status).toBe('open')
    expect(session.snapshot().localPosition).toBe(4)
    expect(runner.status).toBe('disposed')
    expect(() => runner.snapshot()).toThrowError(expect.objectContaining({ code: 'TOOL_RUNNER_INACTIVE' }))
  } finally {
    release.resolve(); await pending.catch(() => undefined)
    for (const resource of [runner, registration, registry, provider, capabilities, repo]) await resource.dispose().catch(() => undefined)
  }
})

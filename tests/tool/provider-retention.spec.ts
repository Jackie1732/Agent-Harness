import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import type { ToolExecution } from '../../src/tool/contract.js'
import { createToolDefinition } from '../../src/tool/definition.js'
import { ScriptedToolProvider, createScriptedToolExecution } from '../../src/tool/providers/scripted.js'

const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
const limits = { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536,
  maxArgumentsBytes: 4096, maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 65536, maxJournalConflicts: 4 }
const definition = createToolDefinition({ name: 'retirement_probe', version: 1,
  description: 'Return an empty local result', operationClass: 'pure',
  inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }, schemaLimits)
const descriptor = { providerId: 'retirement', adapterVersion: '1', resourceId: 'local',
  tools: [{ name: definition.name, version: definition.version }], maxConcurrentExecutions: 1,
  maxArgumentsBytes: 4096, maxResultBytes: 65536 }
class Resource { readonly value = 'owned-callback' }
const scriptedCleanupFailure = new Error('scripted cleanup failed')
async function collect(): Promise<void> { await setImmediate(); queryObjects(Resource, { format: 'count' }) }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('retires Scripted Provider callbacks with an unused binding and terminal Provider retained', async () => {
  async function fixture() {
    const resource = new Resource()
    const provider = new ScriptedToolProvider({ descriptor, onPrepare: () => { void resource.value },
      acquire: () => createScriptedToolExecution(() => ({ kind: 'success', value: { text: resource.value } }), () => {}),
    })
    const binding = provider.prepare(definition, {}, limits)
    await provider.dispose()
    return { provider, binding, ref: new WeakRef(resource) }
  }
  const retained = await fixture(); await collect()
  expect(retained.ref.deref()).toBeUndefined()
  expect(retained.provider.dispose()).toBe(retained.provider.dispose())
  expect(retained.provider.descriptor).toEqual(descriptor)
  expect(() => retained.provider.prepare(definition, {}, limits)).toThrowError(expect.objectContaining({ code: 'TOOL_PROVIDER_INACTIVE' }))
  await expect(retained.binding.acquire(retained.binding.plan, new AbortController().signal)).rejects.toMatchObject({ code: 'TOOL_PROVIDER_INACTIVE' })
})

it.each([[true, false], [true, true], [false, false]])(
  'retires a closed execution with started=%s and failed cleanup=%s', async (started, failed) => {
    async function fixture() {
      const resource = new Resource(), caller = new AbortController()
      caller.signal.addEventListener('abort', () => { void resource.value })
      const inner: ToolExecution = { start: () => ({ kind: 'success', value: {} }),
        close: async () => { if (failed) throw new Error(resource.value); void resource.value } }
      const provider = new ScriptedToolProvider({ descriptor, acquire: () => inner })
      const binding = provider.prepare(definition, {}, limits)
      const execution = await binding.acquire(binding.plan, caller.signal)
      if (started) await execution.start()
      const close = execution.close(); await close.catch(() => undefined)
      await provider.dispose().catch(() => undefined)
      return { execution, close, refs: { inner: new WeakRef(inner), resource: new WeakRef(resource), signal: new WeakRef(caller.signal) } }
    }
    const retained = await fixture(); await collect()
    expect(Object.fromEntries(Object.entries(retained.refs).map(([key, ref]) => [key, ref.deref() !== undefined])))
      .toEqual({ inner: false, resource: false, signal: false })
    expect(retained.execution.close()).toBe(retained.close)
    expect(() => retained.execution.start()).toThrowError(expect.objectContaining({ code: 'TOOL_PROVIDER_INACTIVE' }))
    if (failed) await expect(retained.close).rejects.toMatchObject({ code: 'TOOL_CLEANUP_FAILED' })
    else await retained.close
  },
)

it.each([false, true])('retires direct Scripted Execution callbacks with failed cleanup=%s', async failed => {
  async function fixture() {
    const resource = new Resource()
    const execution = createScriptedToolExecution(() => ({ kind: 'success', value: {} }), () => {
      if (failed) { void resource.value; throw scriptedCleanupFailure }
      void resource.value
    })
    await execution.start(); await execution.close().catch(() => undefined)
    return { execution, ref: new WeakRef(resource) }
  }
  const retained = await fixture(); await collect()
  expect(retained.ref.deref()).toBeUndefined()
  expect(retained.execution.close()).toBe(retained.execution.close())
  expect(() => retained.execution.start()).toThrowError('scripted execution is single-use')
})

it('keeps acquisition and cleanup resources until a late execution closes and the Provider drains', async () => {
  const acquiring = deferred(), releaseAcquire = deferred(), closing = deferred(), releaseClose = deferred()
  let stopped = 0, closed = 0
  const provider = new ScriptedToolProvider({ descriptor, acquire: async (_plan, signal) => {
    signal.addEventListener('abort', () => { stopped++ }, { once: true })
    acquiring.resolve(); await releaseAcquire.promise
    return createScriptedToolExecution(() => ({ kind: 'success', value: {} }), async () => {
      closed++; closing.resolve(); await releaseClose.promise
    })
  } })
  const binding = provider.prepare(definition, {}, limits)
  const acquire = binding.acquire(binding.plan, new AbortController().signal)
  const done = { provider: false, execution: false }
  try {
    await acquiring.promise
    const dispose = provider.dispose(); void dispose.then(() => { done.provider = true })
    expect(provider.dispose()).toBe(dispose)
    expect(stopped).toBe(1); expect(done).toEqual({ provider: false, execution: false })
    releaseAcquire.resolve(); const execution = await acquire
    expect(() => execution.start()).toThrowError(expect.objectContaining({ code: 'TOOL_PROVIDER_INACTIVE' }))
    const close = execution.close(); void close.then(() => { done.execution = true })
    await closing.promise
    expect(closed).toBe(1); expect(done).toEqual({ provider: false, execution: false })
    releaseClose.resolve(); await close; await dispose
    expect(done).toEqual({ provider: true, execution: true })
    expect(execution.close()).toBe(close)
  } finally {
    releaseAcquire.resolve(); releaseClose.resolve()
    const execution = await acquire; await execution.close(); await provider.dispose()
  }
})

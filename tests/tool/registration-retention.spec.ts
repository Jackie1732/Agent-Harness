import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import { CapabilityRegistry } from '../../src/capability/registry.js'
import { createToolDefinition } from '../../src/tool/definition.js'
import { borrowTool, ToolRegistry } from '../../src/tool/registry.js'
import type { ToolRegistration } from '../../src/tool/registry.js'
import { ToolError } from '../../src/tool/errors.js'
import { ScriptedToolProvider, createScriptedToolExecution } from '../../src/tool/providers/scripted.js'

const limits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
const definition = createToolDefinition({ name: 'retirement_probe', version: 1,
  description: 'Return an empty local result', operationClass: 'pure',
  inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }, limits)
const providerOptions = {
  descriptor: { providerId: 'retirement-tool', adapterVersion: '1', resourceId: 'local-resource',
    tools: [{ name: definition.name, version: definition.version }], maxConcurrentExecutions: 1,
    maxArgumentsBytes: 4096, maxResultBytes: 8192 },
  acquire: () => createScriptedToolExecution(() => ({ kind: 'success', value: {} }), () => {}),
}
const cleanupFailure = new ToolError('TOOL_CLEANUP_FAILED', 'registration cleanup failed')

it('retires a borrowed Provider while its terminal public ToolRegistration remains reachable', async () => {
  class Provider extends ScriptedToolProvider {}
  async function makeRegistration(): Promise<ToolRegistration> {
    const capabilities = new CapabilityRegistry(), tools = new ToolRegistry(limits)
    const scope = capabilities.scope.derive('tool registration')
    const provider = new Provider(providerOptions)
    const registration = tools.register(scope, definition, provider)
    await registration.dispose()
    await provider.dispose()
    await tools.dispose()
    await capabilities.dispose()
    return registration
  }
  expect(queryObjects(Provider, { format: 'count' })).toBe(0)
  const registration = await makeRegistration()
  await setImmediate()
  expect(queryObjects(Provider, { format: 'count' })).toBe(0)
  expect(registration.status).toBe('disposed')
  expect(registration.definition).toEqual(definition)
  const released = registration.dispose()
  expect(registration.dispose()).toBe(released)
  await released
})

it('retires replacement bindings while their Tool namespace and terminal registrations remain reachable', async () => {
  class Provider extends ScriptedToolProvider {}
  const capabilities = new CapabilityRegistry(), tools = new ToolRegistry(limits)
  const scope = capabilities.scope.derive('replacement tools'), registrations: ToolRegistration[] = []
  async function replace(): Promise<ToolRegistration> {
    const provider = new Provider(providerOptions)
    const registration = tools.register(scope, definition, provider)
    await registration.dispose()
    await provider.dispose()
    return registration
  }
  expect(queryObjects(Provider, { format: 'count' })).toBe(0)
  try {
    for (let index = 0; index < 20; index++) registrations.push(await replace())
    await setImmediate()
    expect(queryObjects(Provider, { format: 'count' })).toBe(0)
    expect(tools.definitions()).toEqual([])
    expect(tools.snapshot()).toEqual([])
    expect(registrations).toHaveLength(20)
    expect(registrations.every(registration => registration.status === 'disposed')).toBe(true)
    expect(scope.status).toBe('accepting')
  } finally { await tools.dispose(); await capabilities.dispose() }
})

it('retires the owning Scope while a terminal registration keeps its definition and shared release', async () => {
  async function fixture() {
    const capabilities = new CapabilityRegistry(), tools = new ToolRegistry(limits)
    const scope = capabilities.scope.derive('retired tool Scope')
    const provider = new ScriptedToolProvider(providerOptions)
    const registration = tools.register(scope, definition, provider)
    let resolve!: () => void
    const flight = new Promise<void>(done => { resolve = done })
    let borrow = borrowTool(tools, definition.name, Symbol('registered invocation'), flight, () => {})
    const compiled = new WeakRef(borrow!.compiled), predicate = new WeakRef(borrow!.compiled.input)
    resolve(); await flight; borrow = undefined
    await registration.dispose(); await tools.dispose(); await provider.dispose(); await capabilities.dispose()
    return { registration, compiled, predicate, scope: new WeakRef(scope) }
  }
  const retained = await fixture(); await setImmediate(); queryObjects(ScriptedToolProvider, { format: 'count' })
  expect(retained.scope.deref()).toBeUndefined()
  expect(retained.compiled.deref()).toBeUndefined()
  expect(retained.predicate.deref()).toBeUndefined()
  expect(retained.registration.status).toBe('disposed')
  expect(retained.registration.definition).toEqual(definition)
  expect(retained.registration.dispose()).toBe(retained.registration.dispose())
})

it('retires a failed registration Scope after its full flight settles while reserving the unsafe name', async () => {
  async function fixture() {
    const capabilities = new CapabilityRegistry(), tools = new ToolRegistry(limits)
    const scope = capabilities.scope.derive('failed tool Scope')
    const provider = new ScriptedToolProvider(providerOptions)
    const registration = tools.register(scope, definition, provider)
    let resolve!: () => void
    const flight = new Promise<void>(done => { resolve = done })
    let borrow = borrowTool(tools, definition.name, Symbol('full invocation'), flight, () => {})
    borrow!.markUnsafe(cleanupFailure)
    const release = registration.dispose()
    let released = false
    void release.catch(() => { released = true })
    await setImmediate()
    expect(registration.status).toBe('retiring')
    expect(released).toBe(false)
    resolve(); await expect(release).rejects.toBe(cleanupFailure)
    borrow = undefined
    expect(tools.snapshot()).toMatchObject([{ status: 'disposed', inFlight: 0 }])
    expect(() => tools.register(scope, definition, provider)).toThrowError(expect.objectContaining({ code: 'TOOL_REGISTRATION_CONFLICT' }))
    await expect(tools.dispose()).rejects.toMatchObject({ code: 'TOOL_CLEANUP_FAILED' })
    await provider.dispose(); await capabilities.dispose()
    return { registration, tools, scope: new WeakRef(scope), release }
  }
  const retained = await fixture(); await setImmediate(); queryObjects(ScriptedToolProvider, { format: 'count' })
  expect(retained.scope.deref()).toBeUndefined()
  expect(retained.registration.status).toBe('disposed')
  expect(retained.registration.dispose()).toBe(retained.release)
  expect(retained.tools.snapshot()).toMatchObject([{ status: 'disposed', inFlight: 0 }])
})

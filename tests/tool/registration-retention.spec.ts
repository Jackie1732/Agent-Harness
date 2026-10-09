import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import { CapabilityRegistry } from '../../src/capability/registry.js'
import { createToolDefinition } from '../../src/tool/definition.js'
import { ToolRegistry } from '../../src/tool/registry.js'
import type { ToolRegistration } from '../../src/tool/registry.js'
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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { h, fixture, deferred, schemaLimits, toolLimits, echoDefinition, descriptor, FaultBackend } from './helpers/tool-fixture.mjs'

test('T7-20/22 same name conflicts locally, while another registry grants no inherited visibility', async () => fixture(async f => {
  const other = new h.ToolRegistry(schemaLimits)
  const registration = other.register(f.scope, f.definition, f.provider)
  try {
    assert.throws(() => other.register(f.scope, f.definition, f.provider), { code: 'TOOL_REGISTRATION_CONFLICT' })
    const rejected = await f.runner.invoke({ name: 'echo', input: { n: 1 } })
    assert.equal(rejected.payload.result.code, 'tool-unavailable'); assert.equal(f.trace.starts, 0)
    const local = f.registry.register(f.scope, f.definition, f.provider); f.registrations.push(local)
    assert.equal((await f.runner.invoke({ name: 'echo', input: { n: 1 } })).payload.outcome, 'succeeded')
  } finally { await registration.dispose(); await other.dispose() }
}, { noRegister: true }))

test('T7-41 cleanup failure disables one provider across registries and Sessions', async () => {
  const a = echoDefinition({ name: 'cleanup_a', operationClass: 'pure', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } })
  const b = echoDefinition({ name: 'cleanup_b', operationClass: 'pure', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } })
  const starts = { cleanup_a: 0, cleanup_b: 0 }
  const provider = new h.ScriptedToolProvider({ descriptor: {
    providerId: 'shared-cleanup', adapterVersion: '1', resourceId: 'ledger',
    tools: [a, b].map(definition => ({ name: definition.name, version: definition.version })),
    maxConcurrentExecutions: 2, maxArgumentsBytes: 4096, maxResultBytes: 8192,
  }, acquire: plan => h.createScriptedToolExecution(() => {
    starts[plan.definition.name]++; return { kind: 'success', value: {} }
  }, () => { if (plan.definition.name === a.name) throw new Error('injected cleanup failure') }) })
  await fixture(async f => {
    const otherRegistry = new h.ToolRegistry(schemaLimits)
    const first = f.registry.register(f.scope, a, provider); f.registrations.push(first)
    const second = otherRegistry.register(f.scope, b, provider); f.registrations.push(second)
    const otherSession = await f.repository.create()
    const otherRunner = f.makeRunner({ session: otherSession, registry: otherRegistry })
    try {
      await assert.rejects(f.runner.invoke({ name: a.name, input: {} }), { code: 'TOOL_CLEANUP_FAILED' })
      await assert.rejects(otherRunner.invoke({ name: b.name, input: {} }), { code: 'TOOL_PROVIDER_INACTIVE' })
      assert.equal(starts.cleanup_a, 1); assert.equal(starts.cleanup_b, 0)
      const settlement = otherRunner.snapshot().invocations[0]
      assert.equal(settlement.state, 'settled'); assert.equal(settlement.settled.payload.result.code, 'TOOL_PROVIDER_INACTIVE')
    } finally { await otherRegistry.dispose() }
  }, { definition: a, provider, noRegister: true, allowCleanupFailure: true })
})

for (const failActivation of [false, true]) {
  test(`T7-21 real Component staging is hidden and ${failActivation ? 'rollback never publishes' : 'commit publishes'}`, async () => {
    const entered = deferred(), release = deferred()
    await fixture(async f => {
      f.releaseOnCleanup(release)
      let registration
      const component = f.capabilities.mount({ label: 'staged-tool', requires: [], provides: [], setup: async context => {
        registration = await context.apply('registration', () => f.registry.register(context.scope, f.definition, f.provider), value => value.dispose())
        entered.resolve(); await release.promise
        if (failActivation) throw new Error('intentional activation rollback')
      } })
      await entered.promise
      assert.equal(registration.status, 'staging'); assert.equal(f.registry.definitions().length, 0)
      const result = await f.runner.invoke({ name: 'echo', input: { n: 1 } })
      assert.equal(result.payload.result.code, 'tool-unavailable'); assert.equal(f.trace.starts, 0)
      release.resolve(); await f.capabilities.whenQuiescent()
      assert.equal(f.registry.definitions().length, failActivation ? 0 : 1)
      if (!failActivation) assert.equal((await f.runner.invoke({ name: 'echo', input: { n: 1 } })).payload.outcome, 'succeeded')
      await component.dispose()
    }, { noRegister: true })
  })
}

test('T7-23/24 registration closes admission synchronously and reserves its name through CP2', async () => {
  const committing = deferred(), release = deferred()
  const backend = new FaultBackend(new h.MemorySessionBackend({ maxRecordBytes: 262144 }), async event => {
    if (event.type === 'tool/invocation-settled') { committing.resolve(); await release.promise }
  })
  await fixture(async f => {
    f.releaseOnCleanup(release)
    const task = f.runner.invoke({ name: 'echo', input: { n: 1 } }); await committing.promise
    assert.equal(f.trace.closes, 1); assert.equal(f.registry.snapshot()[0].inFlight, 1)
    const disposing = f.registration.dispose(); assert.equal(f.registration.status, 'retiring')
    assert.equal(f.registry.definitions().length, 0)
    assert.throws(() => f.registry.register(f.scope, f.definition, f.provider), { code: 'TOOL_REGISTRATION_CONFLICT' })
    release.resolve(); await task; await disposing
    const replacement = f.registry.register(f.scope, f.definition, f.provider); f.registrations.push(replacement)
    assert.equal(replacement.status, 'active'); assert.equal(f.trace.starts, 1)
  }, { backend })
})

test('T7-25 thin Component releases provider only after registration and the full invocation', async () => {
  const capabilities = new h.CapabilityRegistry(), entered = deferred(), release = deferred()
  const key = h.createCapabilityKey('test.registry')
  const repository = new h.SessionRepository({ backend: new h.MemorySessionBackend({ maxRecordBytes: 262144 }),
    catalog: h.createDurableEventCatalog(h.toolSessionEventDefinitions), maxLineageDepth: 0 })
  const session = await repository.create(), definition = echoDefinition(), policyLife = new AbortController()
  let registry, runner, closes = 0, providerCloses = 0
  const stopping = deferred()
  const registryComponent = capabilities.mount(h.createToolRegistryComponent({ label: 'registry', key, limits: schemaLimits }))
  capabilities.mount({ label: 'capture-registry', requires: [key], provides: [], setup: context => { registry = context.require(key) } })
  const providerComponent = capabilities.mount(h.createToolProviderComponent({ label: 'provider', registryKey: key, definition,
    createProvider: () => {
      const provider = new h.ScriptedToolProvider({ descriptor: descriptor(definition), acquire: (plan, signal) => {
        signal.addEventListener('abort', () => stopping.resolve(), { once: true })
        return h.createScriptedToolExecution(async () => {
          entered.resolve(); await release.promise; return { kind: 'success', value: plan.input }
        }, () => { closes++ })
      } })
      return { descriptor: provider.descriptor, prepare: provider.prepare.bind(provider), dispose: async () => { providerCloses++; await provider.dispose() } }
    },
  }))
  try {
    await capabilities.whenQuiescent()
    runner = new h.SessionToolRunner({ session, registry, scope: capabilities.scope.derive('consumer'), limits: toolLimits,
      policy: { policyId: 'test', version: 1, signal: policyLife.signal, decide: () => ({ kind: 'allow', reasonCode: 'test' }) } })
    const task = runner.invoke({ name: 'echo', input: { n: 1 } }); await entered.promise
    const disposing = providerComponent.dispose()
    await stopping.promise
    assert.equal(providerCloses, 0); assert.equal(closes, 0)
    release.resolve(); const result = await task; await disposing
    assert.equal(result.payload.outcome, 'cancelled'); assert.equal(closes, 1); assert.equal(providerCloses, 1)
    assert.equal(registry.definitions().length, 0)
  } finally {
    release.resolve(); await runner?.dispose(); await providerComponent.dispose(); await registryComponent.dispose(); await capabilities.dispose(); await repository.dispose()
  }
})

test('T7-03/26 public snapshots and root exports contain no ticket, journal, or I/O authority', async () => fixture(async f => {
  const snapshot = f.registry.snapshot()
  assert.equal(Object.hasOwn(snapshot[0], 'providerInstance'), false)
  assert.equal(JSON.stringify(snapshot).includes('rootPath'), false)
  for (const name of ['ToolJournal', 'borrowTool', 'ToolExecutionPool', 'compileDefinition', 'createWorkspaceReadTextProviderWithIO', 'nodeWorkspaceIO', 'decodePlan']) {
    assert.equal(Object.hasOwn(h, name), false, name)
  }
}))


test('T7-24 captured prepare method cannot be replaced while CP0 is committing', async () => {
  const entered = deferred(), release = deferred()
  const definition = echoDefinition()
  let oldStarts = 0, newPrepares = 0
  const implementation = new h.ScriptedToolProvider({ descriptor: descriptor(definition), acquire: plan =>
    h.createScriptedToolExecution(() => { oldStarts++; return { kind: 'success', value: plan.input } }, () => {}) })
  const provider = { descriptor: implementation.descriptor, prepare: implementation.prepare.bind(implementation), dispose: () => implementation.dispose() }
  const backend = new FaultBackend(new h.MemorySessionBackend({ maxRecordBytes: 262144 }), async event => {
    if (event.type === 'tool/invocation-requested') { entered.resolve(); await release.promise }
  })
  await fixture(async f => {
    f.releaseOnCleanup(release)
    const task = f.runner.invoke({ name: 'echo', input: { n: 1 } })
    await entered.promise
    provider.prepare = () => { newPrepares++; throw new Error('replacement must not run') }
    release.resolve()
    assert.equal((await task).payload.outcome, 'succeeded')
    assert.equal(oldStarts, 1); assert.equal(newPrepares, 0)
  }, { definition, provider, backend })
})

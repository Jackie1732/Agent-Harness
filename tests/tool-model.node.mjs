import assert from 'node:assert/strict'
import { test } from 'node:test'
import { h, fixture, deferred, schemaLimits, echoDefinition, descriptor, scriptedModel, toolEvents } from './helpers/tool-fixture.mjs'

// Sources come from the actual Model runtime's committed Session history.
test('T7-12/46 model reference is read locally and a settled duplicate never reauthorizes', async () => fixture(async f => {
  const model = scriptedModel(f); const generated = await model.invoke()
  const reference = { invocationId: generated.payload.invocationId, outputBlockIndex: 0 }
  assert.throws(() => f.runner.invokeModelIntent({ ...reference, validJson: true }), { code: 'TOOL_SOURCE_INVALID' })
  const result = await f.runner.invokeModelIntent(reference)
  assert.equal(result.payload.outcome, 'succeeded')
  const count = f.session.snapshot().localPosition
  await f.registration.dispose(); await f.provider.dispose(); f.policyLife.abort()
  const duplicate = await f.runner.invokeModelIntent(reference)
  assert.deepEqual(duplicate, result); assert.equal(f.session.snapshot().localPosition, count)
  assert.equal(f.trace.starts, 1); assert.equal(f.trace.approvals, 1)
  const request = f.runner.snapshot().invocations[0].requested
  const forged = structuredClone(f.session.snapshot())
  const altered = forged.history.at(-1).events.find(e => e.stored.eventId === request.stored.eventId)
  altered.payload.source.preparedEventId = altered.payload.source.settledEventId
  altered.stored.payload = structuredClone(altered.payload)
  assert.throws(() => h.projectToolSession(forged), { code: 'TOOL_STATE_INVALID' })
}))

test('T7-13/56 ancestor and peer model intent do not become child or peer work', async () => fixture(async f => {
  const generated = await scriptedModel(f).invoke()
  const reference = { invocationId: generated.payload.invocationId, outputBlockIndex: 0 }
  const child = await f.repository.fork(f.session.header.sessionId)
  const peer = await f.repository.create()
  for (const session of [child, peer]) {
    const runner = f.makeRunner({ session })
    await assert.rejects(runner.invokeModelIntent(reference), { code: 'TOOL_SOURCE_INVALID' })
    assert.equal(h.projectToolSession(session.snapshot()).invocations.length, 0)
  }
  assert.equal(f.trace.starts, 0)
}))

test('T7-14 model stream parameters before CP2 cannot execute', async () => {
  const entered = deferred(), release = deferred()
  await fixture(async f => {
    f.releaseOnCleanup(release)
    const model = scriptedModel(f, undefined, { beforeComplete: async () => { entered.resolve(); await release.promise } })
    const generating = model.invoke(); await entered.promise
    const invocationId = model.runner.snapshot().invocations.at(-1).invocationId
    await assert.rejects(f.runner.invokeModelIntent({ invocationId, outputBlockIndex: 0 }), { code: 'TOOL_SOURCE_NOT_ACTIONABLE' })
    assert.equal(toolEvents(f.session).length, 0); assert.equal(f.trace.starts, 0)
    release.resolve(); await generating
  })
})
for (const stopReason of ['length', 'refusal', 'content-filter']) {
  test(`T7-15 ${stopReason} model result is not actionable even with complete JSON`, async () => fixture(async f => {
    const result = await scriptedModel(f, undefined, { stopReason }).invoke()
    await assert.rejects(f.runner.invokeModelIntent({ invocationId: result.payload.invocationId, outputBlockIndex: 0 }), { code: 'TOOL_SOURCE_NOT_ACTIONABLE' })
    assert.equal(toolEvents(f.session).length, 0); assert.equal(f.trace.starts, 0)
  }))
}
test('T7-15 a cancelled Model settlement cannot become Tool work', async () => {
  const entered = deferred(), release = deferred(), signal = new AbortController()
  await fixture(async f => {
    f.releaseOnCleanup(release)
    const model = scriptedModel(f, undefined, { beforeComplete: async () => { entered.resolve(); await release.promise } })
    const pending = model.invoke({ signal: signal.signal })
    await entered.promise; signal.abort(); release.resolve()
    const result = await pending
    assert.equal(result.payload.outcome, 'cancelled')
    await assert.rejects(f.runner.invokeModelIntent({ invocationId: result.payload.invocationId, outputBlockIndex: 0 }), { code: 'TOOL_SOURCE_NOT_ACTIONABLE' })
    assert.equal(toolEvents(f.session).length, 0); assert.equal(f.trace.starts, 0)
  })
})

test('T7-15 a failed Model settlement cannot become Tool work', async () => fixture(async f => {
  const result = await scriptedModel(f, undefined, { beforeComplete: () => { throw new Error('private model failure') } }).invoke()
  assert.equal(result.payload.outcome, 'failed')
  await assert.rejects(f.runner.invokeModelIntent({ invocationId: result.payload.invocationId, outputBlockIndex: 0 }), { code: 'TOOL_SOURCE_NOT_ACTIONABLE' })
  assert.equal(toolEvents(f.session).length, 0); assert.equal(f.trace.starts, 0)
}))

test('T7-15 a cleanup-incomplete Model settlement cannot become Tool work', async () => fixture(async f => {
  const model = scriptedModel(f, undefined, { onClose: () => { throw new Error('private model cleanup failure') } })
  await assert.rejects(model.invoke(), { code: 'MODEL_CLEANUP_FAILED' })
  const invocation = model.runner.snapshot().invocations.at(-1)
  assert.equal(invocation.state, 'settled'); assert.equal(invocation.settled.payload.cleanup.status, 'incomplete')
  await assert.rejects(f.runner.invokeModelIntent({ invocationId: invocation.invocationId, outputBlockIndex: 0 }), { code: 'TOOL_SOURCE_NOT_ACTIONABLE' })
  assert.equal(toolEvents(f.session).length, 0); assert.equal(f.trace.starts, 0)
}, { allowCleanupFailure: true }))

test('T7-16 invalid model JSON becomes rejected feedback without repairing the original', async () => fixture(async f => {
  const raw = '{"n":'
  const generated = await scriptedModel(f, [{ name: 'echo', argumentsText: raw }]).invoke()
  const result = await f.runner.invokeModelIntent({ invocationId: generated.payload.invocationId, outputBlockIndex: 0 })
  assert.equal(result.payload.outcome, 'rejected'); assert.equal(result.payload.result.code, 'invalid-arguments')
  const before = f.runner.snapshot().invocations[0].requested.payload
  assert.equal(before.arguments.text, raw); assert.equal(f.trace.starts, 0); assert.equal(f.trace.approvals, 0)
  const history = h.modelToolHistory(f.session.snapshot(), generated.payload.invocationId)
  assert.equal(history.assistant.content[0].argumentsText, raw)
  assert.equal(history.results.content[0].isError, true)
}))

test('T7-17 unadvertised intent is a durable rejection, not a registry lookup authorization', async () => fixture(async f => {
  const generated = await scriptedModel(f, [{ name: 'echo', argumentsText: '{"n":1}' }], { tools: [] }).invoke()
  const result = await f.runner.invokeModelIntent({ invocationId: generated.payload.invocationId, outputBlockIndex: 0 })
  assert.equal(result.payload.outcome, 'rejected'); assert.equal(result.payload.result.code, 'not-advertised')
  assert.equal(f.trace.prepares, 0); assert.equal(f.trace.starts, 0)
}))
for (const drift of ['description', 'schema']) {
  test(`T7-18 full ${drift} drift is rejected despite the same name`, async () => fixture(async f => {
    const generated = await scriptedModel(f).invoke()
    await f.registration.dispose()
    const changed = h.createToolDefinition({ ...f.definition, ...(drift === 'description'
      ? { description: 'Different semantics' } : { inputSchema: { ...f.definition.inputSchema, additionalProperties: true } }) }, schemaLimits)
    f.registrations.push(f.registry.register(f.scope, changed, f.provider))
    const result = await f.runner.invokeModelIntent({ invocationId: generated.payload.invocationId, outputBlockIndex: 0 })
    assert.equal(result.payload.result.code, 'surface-mismatch'); assert.equal(f.trace.starts, 0)
  }))
}

test('T7-19 execution-time version and provider are recorded without inventing model-time identity', async () => fixture(async f => {
  const generated = await scriptedModel(f).invoke(); await f.registration.dispose()
  const selected = echoDefinition({ version: 2 })
  let starts = 0
  const provider = new h.ScriptedToolProvider({ descriptor: descriptor(selected, 1, { providerId: 'replacement' }),
    acquire: plan => h.createScriptedToolExecution(() => { starts++; return { kind: 'success', value: plan.input } }, () => {}) })
  f.providers.push(provider); f.registrations.push(f.registry.register(f.scope, selected, provider))
  const result = await f.runner.invokeModelIntent({ invocationId: generated.payload.invocationId, outputBlockIndex: 0 })
  assert.equal(result.payload.outcome, 'succeeded'); assert.equal(starts, 1); assert.equal(f.trace.starts, 0)
  const selection = f.runner.snapshot().invocations[0].requested.payload.selection
  assert.equal(selection.definition.version, 2); assert.equal(selection.provider.providerId, 'replacement')
  const original = h.projectModelSession(f.session.snapshot()).invocations[0].prepared.payload.submission.request.tools[0]
  assert.equal(Object.hasOwn(original, 'providerId'), false); assert.equal(Object.hasOwn(original, 'version'), false)
}))

test('T7-68 all calls must be settled once and preserved in original order', async () => fixture(async f => {
  const generated = await scriptedModel(f, [{ name: 'echo', argumentsText: '{"n":1}' }, { name: 'echo', argumentsText: '{"n":2}' }]).invoke()
  const invocationId = generated.payload.invocationId
  await f.runner.invokeModelIntent({ invocationId, outputBlockIndex: 1 })
  assert.throws(() => h.modelToolHistory(f.session.snapshot(), invocationId), { code: 'TOOL_HISTORY_INCOMPLETE' })
  await f.runner.invokeModelIntent({ invocationId, outputBlockIndex: 0 })
  const history = h.modelToolHistory(f.session.snapshot(), invocationId)
  assert.deepEqual(history.assistant.content.map(block => block.callId), ['call-0', 'call-1'])
  assert.deepEqual(history.results.content.map(block => block.callId), ['call-0', 'call-1'])
  assert.deepEqual(history.results.content.map(block => block.result.value), [{ n: 1 }, { n: 2 }])
  assert.equal(f.trace.starts, 2)
}))

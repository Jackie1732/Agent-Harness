import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import * as h from '../dist/index.js'
import { readModelIntent, validateRequestSource } from '../dist/tool/source.js'

const modelLimits = { maxInputBytes: 32768, maxNormalizedResultBytes: 8192, maxOutputBlocks: 16,
  maxToolCalls: 0, maxJournalConflicts: 4 }
const toolLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000, maxRequestBytes: 65536,
  maxPlanBytes: 65536, maxArgumentsBytes: 4096, maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 }
async function* modelFrames() {
  yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'retention-response' }
  yield { kind: 'block-start', index: 0, block: 'text' }
  yield { kind: 'text-delta', index: 0, text: 'A real completed text result.' }
  yield { kind: 'block-end', index: 0 }
  yield { kind: 'complete', stopReason: 'stop' }
}

// Module-level helpers keep the fixture Snapshot out of the retained Error's function closures.
function sourceFailure(entry, snapshot, intent) {
  try {
    if (entry === 'intent') readModelIntent(snapshot, intent)
    else validateRequestSource({ invocationId: h.parseToolInvocationId('40000000-0000-4000-8000-000000000299'),
      selection: { kind: 'missing' }, limits: toolLimits, source: { kind: 'model', intent,
      preparedEventId: snapshot.history[0].events[0].stored.eventId,
      settledEventId: snapshot.history[0].events.at(-1).stored.eventId, callId: 'unused' },
    name: 'echo', arguments: { kind: 'text', text: '{}' } }, snapshot, snapshot.localPosition + 1)
  } catch (error) { return error }
  throw new Error('Fixture source should be refused')
}

async function observation(entry, kind, keepSnapshot) {
  const repository = new h.SessionRepository({ backend: new h.MemorySessionBackend({ maxRecordBytes: 262144 }),
    catalog: h.createDurableEventCatalog(h.modelSessionEventDefinitions), maxLineageDepth: 0 })
  const provider = new h.ScriptedModelProvider({ providerId: 'retention', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 }, script: modelFrames })
  const session = await repository.create(), runner = new h.SessionModelRunner({ session, provider, limits: modelLimits })
  try {
    const result = await runner.invoke({ model: 'fixture-model', instructions: [],
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'Read source lifetime.' }] }], tools: [], maxOutputTokens: 32 })
    const snapshot = session.snapshot()
    assert.equal(h.projectModelSession(snapshot).invocations[0].state, 'settled')
    const intent = { invocationId: kind === 'missing' ? h.parseModelInvocationId('40000000-0000-4000-8000-000000000199')
      : result.payload.invocationId, outputBlockIndex: 0 }
    const keeper = sourceFailure(entry, snapshot, intent)
    const code = kind === 'missing' ? 'TOOL_SOURCE_INVALID' : 'TOOL_SOURCE_NOT_ACTIONABLE'
    assert.equal(keeper.code, code)
    return { keeper, code, snapshot: keepSnapshot ? snapshot : undefined,
      references: [new WeakRef(snapshot), new WeakRef(snapshot.history[0])] }
  } finally { await runner.dispose(); await provider.dispose(); await repository.dispose() }
}

async function collect() {
  await setImmediate()
  queryObjects(h.SessionRepository, { format: 'count' })
  await setImmediate()
  queryObjects(h.SessionRepository, { format: 'count' })
}

for (const entry of ['intent', 'request']) for (const kind of ['missing', 'unactionable']) {
  test(`retained ${entry} ${kind} Error releases the Snapshot without reading its stack`, async () => {
    const state = await observation(entry, kind, false)
    await collect()
    assert.equal(state.keeper.code, state.code)
    assert.deepEqual(state.references.map(reference => reference.deref() !== undefined), [false, false])
  })
}
test('an explicitly retained Snapshot keeps its complete Model history readable', async () => {
  const state = await observation('intent', 'missing', true)
  await collect()
  assert.equal(state.keeper.code, state.code)
  assert.deepEqual(state.references.map(reference => reference.deref() !== undefined), [true, true])
  assert.equal(h.projectModelSession(state.snapshot).invocations[0].state, 'settled')
})

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as harness from '../dist/index.js'

// Only the built package's public root is used. No loader, test seam, or cloud account.
const root = await mkdtemp(join(tmpdir(), 'model-built-smoke-'))
const makeRepository = () => new harness.SessionRepository({
  backend: new harness.FileSessionBackend({ root, maxRecordBytes: 65536 }),
  catalog: harness.createDurableEventCatalog(harness.modelSessionEventDefinitions),
  maxLineageDepth: 0,
})
const repository = makeRepository()
const provider = new harness.ScriptedModelProvider({
  providerId: 'built-smoke', maxConcurrentExchanges: 1,
  streamLimits: { maxFrameBytes: 8192, maxStreamBytes: 65536, maxFrames: 64 },
  script: async function* () {
    yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'built-response' }
    yield { kind: 'block-start', index: 0, block: 'text' }
    yield { kind: 'text-delta', index: 0, text: 'durable result' }
    yield { kind: 'block-end', index: 0 }
    yield { kind: 'complete', stopReason: 'stop' }
  },
})
let runner
try {
  const session = await repository.create()
  runner = new harness.SessionModelRunner({ session, provider, limits: {
    maxInputBytes: 32768, maxNormalizedResultBytes: 8192,
    maxOutputBlocks: 16, maxToolCalls: 0, maxJournalConflicts: 4,
  } })
  const result = await runner.invoke({
    model: 'fixture-model', instructions: [], tools: [], maxOutputTokens: 32,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'test' }] }],
  })
  assert.equal(result.payload.outcome, 'completed')
  const before = runner.snapshot()
  await runner.dispose(); await provider.dispose(); await repository.dispose()
  const reopened = makeRepository()
  try {
    const snapshot = await reopened.read(session.header.sessionId)
    assert.deepEqual(harness.projectModelSession(snapshot), before)
    assert.equal(snapshot.localPosition, 3)
  } finally { await reopened.dispose() }
  for (const name of ['ModelJournal', 'ModelResponseAccumulator', 'ExchangeCapacity', 'ModelHttpRequest']) {
    assert.equal(Object.hasOwn(harness, name), false, `${name} must remain internal`)
  }
  console.log('Model public-root built smoke passed (offline).')
} finally {
  await runner?.dispose(); await provider.dispose(); await repository.dispose()
  await rm(root, { recursive: true, force: true })
}

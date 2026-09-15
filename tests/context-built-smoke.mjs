import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as harness from '../dist/index.js'

const backend = new harness.MemorySessionBackend({ maxRecordBytes: 2 * 1024 * 1024 })
const repository = new harness.SessionRepository({
  backend,
  catalog: harness.createDurableEventCatalog([
    ...harness.contextSessionEventDefinitions,
    ...harness.modelSessionEventDefinitions,
  ]),
  maxLineageDepth: 4,
  identitySource: { nextSessionId: () => harness.parseSessionId('60000000-0000-4000-8000-000000000101') },
  clock: { now: () => 1_789_257_600_000 },
})
const provider = new harness.ScriptedModelProvider({
  providerId: 'context-built',
  maxConcurrentExchanges: 1,
  streamLimits: { maxFrameBytes: 16_384, maxStreamBytes: 262_144, maxFrames: 1000 },
  script: async function* () {},
})
const directory = await mkdtemp(join(tmpdir(), 'atomic-context-replay-'))
try {
  const session = await repository.create()
  const context = new harness.SessionContext({ session, messageCatalog: harness.createMessageCatalog() })
  const profile = await context.recordProfile({
    profileKey: 'built', purpose: 'generation', previousEventId: null,
    sections: [{ name: 'rules', slot: 'rules', ordinal: 0, text: 'Be exact.', originLabel: 'built smoke' }],
    toolNames: [], rendererVersion: 'context-neutral/v1', historyScope: 'local-only',
    tokenAccounting: { mode: 'estimate-accepted', algorithm: 'neutral-json-utf8-estimate/v1', bytesPerEstimatedToken: 4, fixedOverheadEstimate: 8 },
    budget: {
      contextWindowTokens: 262_144, outputReserveTokens: 4096, safetyMarginTokens: 256,
      maxRequestBytes: 1024 * 1024, maxAssemblyBytes: 1536 * 1024,
      maxSourceEvents: 10_000, maxSourceBytes: 64 * 1024 * 1024, maxUnits: 10_000,
      maxProvenanceEntries: 20_000, maxMemoryCandidates: 1000, maxMemoryEstimatedTokens: 64_000,
      maxJsonDepth: 64, maxJsonNodes: 250_000, minSavingsBytes: 1,
    },
  })
  const input = await context.recordInput({
    kind: 'user', origin: 'host-authored', originLabel: 'built smoke', text: `offline replay ${'材料🙂'.repeat(800)}`,
  })
  const selection = {
    profileEventId: profile.stored.eventId,
    target: { model: 'fixture-model', maxOutputTokens: 256, provider: provider.descriptor },
    requiredInputs: [{ eventId: input.stored.eventId, selector: 'user-input' }],
    observations: [], history: { mode: 'local-suffix', representation: 'raw' }, compactions: [],
    memory: { required: [], query: { requiredTags: [], queryTags: [], topK: 0 } },
    inbox: [], outboxPayloads: [], compactionSource: null,
  }
  const assembled = await context.assemble(selection)
  assert.equal(assembled.kind, 'ready')
  assert.equal(assembled.request.messages[0].content[0].text.startsWith('offline replay'), true)
  const path = join(directory, 'snapshot.json')
  await writeFile(path, JSON.stringify({
    snapshot: session.snapshot(),
    assemblyEventId: assembled.committed.stored.eventId,
    requestDigest: assembled.committed.payload.requestDigest,
  }))
  const child = spawnSync(process.execPath, ['tests/context-replay-child.mjs', path], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH },
  })
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /context-replay-child: ok/)

  const compacted = await context.compact({
    profileEventId: profile.stored.eventId,
    history: { mode: 'local-suffix', representation: 'raw' },
    units: [{ eventId: input.stored.eventId, selector: 'user-input' }],
    protectedRefs: [], maxExcerptBytes: 16,
  })
  assert.equal(compacted.kind, 'committed')
  assert.equal(session.status, 'open')
  await context.dispose()
} finally {
  await provider.dispose()
  await repository.dispose()
  await rm(directory, { recursive: true, force: true })
}

process.stdout.write('context-built-smoke: ok\n')

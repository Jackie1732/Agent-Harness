// T7-03/61/67/68: actual public Model -> Tool -> Model composition; execution is a build-gate obligation.
/** Explicit Model -> Tool -> Model once each. This is a fixture, not an Agent loop. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as h from '../dist/index.js'

const temporary = await mkdtemp(join(tmpdir(), 'harness-tool-built-'))
const workspace = join(temporary, 'workspace'), store = join(temporary, 'sessions')
const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
const limits = { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096,
  maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 }
const text = '原子化 Agent：只读文件与持久结算。\nSecond line.\n'
let repository, capabilities, registry, native, registration, tool, modelProvider, model
let primary
try {
  await mkdir(workspace); await mkdir(store)
  await writeFile(join(workspace, '中文 笔记.txt'), text)
  repository = new h.SessionRepository({ backend: new h.FileSessionBackend({ root: store, maxRecordBytes: 262144 }),
    catalog: h.createDurableEventCatalog([...h.toolSessionEventDefinitions, ...h.modelSessionEventDefinitions]), maxLineageDepth: 2 })
  const session = await repository.create()
  capabilities = new h.CapabilityRegistry()
  const scope = capabilities.scope.derive('explicit-tool-consumer')
  registry = new h.ToolRegistry(schemaLimits)
  const definition = h.createReadTextDefinition(schemaLimits)
  native = await h.createWorkspaceReadTextProvider({ rootId: 'research', rootPath: workspace, protectedRoots: [store],
    maxReadBytes: 1024, maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 8192, schemaLimits })
  registration = registry.register(scope, definition, native)
  const policyLife = new AbortController()
  let approvals = 0
  tool = new h.SessionToolRunner({ session, registry, scope, limits, policy: {
    policyId: 'fixture-read-only', version: 1, signal: policyLife.signal,
    decide: input => {
      approvals++
      assert.equal(input.plan.target.kind, 'workspace-file')
      assert.equal(input.plan.target.rootId, 'research')
      assert.equal(input.plan.target.path, '中文 笔记.txt')
      assert.equal(input.plan.target.maxBytes, 1024)
      return { kind: 'allow', reasonCode: 'fixture-approved' }
    },
  } })
  let modelCalls = 0
  modelProvider = new h.ScriptedModelProvider({ providerId: 'explicit-roundtrip', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 8192, maxStreamBytes: 65536, maxFrames: 64 },
    script: async function* () {
      const call = ++modelCalls
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: `response-${call}` }
      if (call === 1) {
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'read-1', name: 'read_text' }
        yield { kind: 'arguments-delta', index: 0, text: '{"path":"中文 笔记.txt"}' }
        yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: 'tool-calls' }
      } else {
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: 'The committed tool result was explicitly supplied.' }
        yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: 'stop' }
      }
    },
  })
  model = new h.SessionModelRunner({ session, provider: modelProvider,
    limits: { maxInputBytes: 65536, maxNormalizedResultBytes: 8192, maxOutputBlocks: 16, maxToolCalls: 4, maxJournalConflicts: 4 } })
  const request = { model: 'fixture-model', instructions: [], messages: [{ role: 'user', content: [{ kind: 'text', text: 'Read the authorized note.' }] }],
    tools: [h.describeToolForModel(definition)], maxOutputTokens: 64 }
  const first = await model.invoke(request)
  assert.equal(first.payload.outcome, 'completed')
  const origin = first.payload.invocationId
  const result = await tool.invokeModelIntent({ invocationId: origin, outputBlockIndex: 0 })
  assert.equal(result.payload.outcome, 'succeeded')
  assert.deepEqual(result.payload.result.value, { path: '中文 笔记.txt', text, byteLength: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex') })
  assert.equal(result.payload.cleanup.status, 'complete')
  const history = h.modelToolHistory(session.snapshot(), origin)
  const second = await model.invoke({ ...request, messages: [...request.messages, history.assistant, history.results] })
  assert.equal(second.payload.outcome, 'completed'); assert.equal(modelCalls, 2); assert.equal(approvals, 1)
  const snapshot = session.snapshot()
  const encoded = JSON.stringify(snapshot)
  assert.equal(encoded.includes(JSON.stringify(workspace).slice(1, -1)), false, 'absolute workspace path must not enter durable facts')
  const expectedPath = join(temporary, 'expected.json')
  await writeFile(expectedPath, JSON.stringify({ tools: h.projectToolSession(snapshot), models: h.projectModelSession(snapshot), history, origin }))
  // Stop borrowers before their providers/writer; only then remove the workspace.
  await tool.dispose(); await model.dispose(); await registration.dispose(); await registry.dispose()
  await native.dispose(); await modelProvider.dispose(); await capabilities.dispose(); await repository.dispose()
  await rm(workspace, { recursive: true })
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./tool-replay-child.mjs', import.meta.url)), store, session.header.sessionId, expectedPath, workspace],
    { maxBuffer: 65536, windowsHide: true })
  assert.match(stdout, /fresh process/)
  console.log('tool built smoke: explicit Model/Tool/Model roundtrip and independent replay passed')
} catch (reason) { primary = reason; throw reason }
finally {
  const failures = []
  for (const resource of [tool, model, registration, registry, native, modelProvider, capabilities, repository]) {
    try { await resource?.dispose() } catch (reason) { failures.push(reason) }
  }
  await rm(temporary, { recursive: true, force: true })
  if (primary === undefined && failures.length > 0) throw new AggregateError(failures, 'built fixture cleanup failed')
}

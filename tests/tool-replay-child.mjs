// T7-70: new Node process replays facts after the parent closes providers and removes the workspace.
/** Separate process: no ToolProvider, ToolRegistry, model service, or workspace reads. */
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { SessionRepository, FileSessionBackend, createDurableEventCatalog, parseSessionId,
  toolSessionEventDefinitions, modelSessionEventDefinitions, projectToolSession, projectModelSession,
  modelToolHistory } from '../dist/index.js'

const [store, id, expectedPath, removedWorkspace] = process.argv.slice(2)
assert.ok(store && id && expectedPath && removedWorkspace)
globalThis.fetch = () => { throw new Error('network is forbidden during replay') }
await assert.rejects(access(removedWorkspace), { code: 'ENOENT' })
const expected = JSON.parse(await readFile(expectedPath, 'utf8'))
const repository = new SessionRepository({ backend: new FileSessionBackend({ root: store, maxRecordBytes: 262144 }),
  catalog: createDurableEventCatalog([...toolSessionEventDefinitions, ...modelSessionEventDefinitions]), maxLineageDepth: 2 })
try {
  const snapshot = await repository.read(parseSessionId(id))
  const tools = projectToolSession(snapshot), models = projectModelSession(snapshot)
  assert.deepEqual(JSON.parse(JSON.stringify(tools)), expected.tools)
  assert.deepEqual(JSON.parse(JSON.stringify(models)), expected.models)
  assert.deepEqual(modelToolHistory(snapshot, expected.origin), expected.history)
  console.log('tool replay: fresh process, original workspace absent, zero providers, stable durable facts')
} finally { await repository.dispose() }

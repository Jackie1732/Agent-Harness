import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h from '../dist/index.js'

const base = await mkdtemp(join(tmpdir(), 'atomic-host-example-'))
const raw = JSON.parse(await readFile(new URL('./host-config.json', import.meta.url), 'utf8'))
raw.storage.root = join(base, 'sessions')
const spec = h.resolveHostConfig(h.decodeHostConfig(raw, base))
const configPath = join(base, 'host.json')
await writeFile(configPath, JSON.stringify(raw))
const cli = fileURLToPath(new URL('../dist/host/bin.js', import.meta.url))
function runCli(command, input = '') {
  const result = spawnSync(process.execPath, [cli, command, '--config', configPath], { input, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim().split('\n').map(line => JSON.parse(line))
}
runCli('init')
const single = runCli('run', JSON.stringify({ protocolVersion: 1, requestId: 'example-task', kind: 'task', agentKey: 'writer', text: 'Hello Harness' }))
assert.equal(single.at(-1).report.members[0].agent.final.text, 'writer answer')

const host = await h.openHost(spec)
try {
  await host.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"review"}' })
  const message = host.report().members[0].agent.pendingOutbox[0].messageId
  assert.equal((await host.run()).deliveryAttempts, 1)
  await host.sendMessage('reviewer', { kind: 'reply', messageId: message, type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"reviewed"}' })
  assert.equal((await host.run()).deliveryAttempts, 1)
} finally { await host.shutdown() }
assert.equal((await h.inspectHost(spec))[0].openRecovery, null)
assert.ok((await h.recoverHost(spec, { predecessorStopped: true, maxRecoveryWrites: 10, maxJournalConflicts: 4 })).every(item => item.result.kind === 'nothing-to-recover'))

// A new root with a different recipe gives this example its own durable question workflow.
const questionRaw = structuredClone(raw)
questionRaw.storage.root = join(base, 'questions')
const writer = questionRaw.members[0]
writer.spec.nativeActions = ['agent_send_message', 'agent_ask_user']
writer.model.runnerLimits.maxToolCalls = 4
const questions = h.resolveHostConfig(h.decodeHostConfig(questionRaw, base))
await h.initializeHost(questions)
function scripted(action, finalText) {
  let calls = 0
  return { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model, script: async function* () {
    const current = calls++ === 0 ? action : null
    yield { kind: 'message-start', reportedModel: 'fixed-model', responseId: 'example' }
    yield current === null ? { kind: 'block-start', index: 0, block: 'text' }
      : { kind: 'block-start', index: 0, block: 'tool-call', name: current.name, callId: 'example-call' }
    yield current === null ? { kind: 'text-delta', index: 0, text: finalText }
      : { kind: 'arguments-delta', index: 0, text: JSON.stringify(current.arguments) }
    yield { kind: 'block-end', index: 0 }
    yield { kind: 'complete', stopReason: current === null ? 'stop' : 'tool-calls' }
  } }) }
}
const questioner = await h.openHost(questions, { bindings: scripted({ name: 'agent_ask_user', arguments: { question: 'Which format?', timeoutMs: 30000 } }, 'unused') })
await questioner.submitTask('writer', 'Prepare a report')
const waiting = (await questioner.run()).members[0].agent
assert.equal(waiting.waits.length, 1)
await questioner.shutdown()
const resumed = await h.openHost(questions, { bindings: scripted(null, 'Markdown report') })
try {
  resumed.pause('writer')
  await resumed.submitAnswer('writer', waiting.waits[0].reference, 'Markdown')
  const maintained = await resumed.run()
  assert.equal(maintained.businessRuns, 0)
  resumed.resume('writer')
  const result = (await resumed.run()).members[0].agent
  assert.equal(result.roots.length, 1)
  assert.equal(result.roots[0].budget.models, 2)
  assert.equal(result.roots[0].deadline, waiting.roots[0].deadline)
  assert.equal(result.final.text, 'Markdown report')
} finally { await resumed.shutdown() }

const toolsRaw = structuredClone(raw)
toolsRaw.storage.root = join(base, 'tools')
const workspace = join(base, 'workspace')
await mkdir(workspace)
await writeFile(join(workspace, 'note.txt'), 'Host tool example')
const toolMember = toolsRaw.members[0]
toolMember.profile.toolNames = toolMember.spec.toolNames = ['read_text']
toolMember.spec.budget.tools = 1
toolMember.model.runnerLimits.maxToolCalls = 4
const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
toolMember.tools = { kind: 'workspace-read-text', rootId: 'example', rootPath: workspace, protectedRoots: [],
  maxReadBytes: 4096, maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 8192, schemaLimits,
  invocationLimits: { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096,
    maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 },
  policy: { policyId: 'read-only', version: 1, decision: 'allow', reasonCode: 'example' } }
const toolsSpec = h.resolveHostConfig(h.decodeHostConfig(toolsRaw, base))
await h.initializeHost(toolsSpec)
const reader = await h.openHost(toolsSpec, { bindings: scripted({ name: 'read_text', arguments: { path: 'note.txt' } }, 'Read complete') })
try {
  await reader.submitTask('writer', 'Read note.txt')
  assert.equal((await reader.run()).members[0].agent.final.text, 'Read complete')
} finally { await reader.shutdown() }
// Configuration directories are protected by CLI runtime binding even when the JSON omits them.
const unsafeConfig = join(workspace, 'host.json')
await writeFile(unsafeConfig, JSON.stringify(toolsRaw))
const refused = spawnSync(process.execPath, [cli, 'run', '--config', unsafeConfig], { input: '', encoding: 'utf8', timeout: 30000 })
assert.notEqual(refused.status, 0)
assert.equal(dirname(unsafeConfig), workspace)
process.stdout.write(`${JSON.stringify({ example: 'host-lifecycle', storage: base,
  passed: ['built CLI', 'local roundtrip', 'offline inspection and recovery', 'question reopen and paused maintenance', 'read_text', 'CLI configuration protection'] })}\n`)

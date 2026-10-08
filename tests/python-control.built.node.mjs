import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as h from '../dist/index.js'
import { decodeApiConfig, resolveApiConfig, openHarnessApiServer } from '../dist/api/index.js'
import { CONTROL_METHODS } from '../dist/protocol/index.js'
import { subagentConfig, delegationRequest, action } from '../examples/subagent-fixture.mjs'
import { workflowConfig, resolveWorkflowConfig } from '../examples/workflow-fixture.mjs'

const python = process.env.ATOMIC_HARNESS_PYTHON
if (python === undefined) throw new Error('Set ATOMIC_HARNESS_PYTHON to a Python >=3.11 interpreter with the SDK installed or the declared generated source available')
const certRoot = fileURLToPath(new URL('./host/certs/', import.meta.url))
const limits = { maxRequestBytes: 1048576, maxResponseBytes: 2097152, maxJsonDepth: 64, maxJsonNodes: 100000, maxHeaderBytes: 8192,
  maxPageEvents: 100, maxConnections: 16, maxPendingInputs: 4, maxPendingControls: 4, maxObservers: 4, maxPendingShutdowns: 4,
  requestReadTimeoutMs: 5000, responseWriteTimeoutMs: 5000, tlsHandshakeTimeoutMs: 5000, headersTimeoutMs: 5000,
  keepAliveTimeoutMs: 1000, maxWaitMs: 5000, observerScanIntervalMs: 5 }

async function api(spec, raw, directory) {
  const fingerprint = new X509Certificate(await readFile(join(certRoot, 'client.pem'))).fingerprint256.replaceAll(':', '').toLowerCase()
  const config = decodeApiConfig({ schemaVersion: 1, listenHost: '127.0.0.1', listenPort: 0,
    tls: { caFile: join(certRoot, 'ca.pem'), serverCertFile: join(certRoot, 'server.pem'), serverKeyFile: join(certRoot, 'server-key.pem') },
    principals: [{ principalKey: 'researcher', certificateFingerprints: [fingerprint], methods: [...CONTROL_METHODS],
      agentKeys: raw.members.filter(member => member.kind === 'local').map(member => member.agentKey),
      workflowKeys: raw.workflows?.kind === 'enabled' ? raw.workflows.definitions.map(entry => entry.definition.workflowKey) : [] }], limits })
  return openHarnessApiServer({ host: spec, api: resolveApiConfig(config, spec, directory), credentials: {} })
}

async function startClient(port) {
  const config = { origin: `https://127.0.0.1:${port}`, tls: { ca_file: join(certRoot, 'ca.pem'), cert_file: join(certRoot, 'client.pem'),
    key_file: join(certRoot, 'client-key.pem'), server_name: 'localhost' }, limits: {
    max_request_bytes: 1048576, max_response_bytes: 2097152, max_json_depth: 64, max_json_nodes: 100000,
    connect_timeout_ms: 5000, request_timeout_ms: 30000, max_connections: 2 } }
  const env = { ...process.env, PYTHONUTF8: '1' }
  if (process.env.ATOMIC_HARNESS_PYTHON_INSTALLED !== '1') env.PYTHONPATH = resolve('python/src')
  else delete env.PYTHONPATH
  const child = spawn(python, [resolve('python/tests/control_client.py'), JSON.stringify(config)], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk) })
  const pending = new Map(); let next = 0, readyResolve, readyReject
  const ready = new Promise((done, reject) => { readyResolve = done; readyReject = reject })
  const readiness = setTimeout(() => { child.kill(); readyReject(new Error(`Python client ready expired: ${stderr}`)) }, 15000)
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const message = JSON.parse(line)
    if (message.kind === 'python-client-ready') { clearTimeout(readiness); readyResolve(); return }
    const entry = pending.get(message.id); if (entry === undefined) return
    pending.delete(message.id); clearTimeout(entry.timer)
    if (message.error !== undefined) entry.reject(Object.assign(new Error(`Python ${entry.method} request failed`), message.error))
    else entry.resolve(message.result)
  })
  const exited = new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', code => {
      clearTimeout(readiness); lines.close()
      readyReject(new Error(`Python exited before ready: ${code}: ${stderr}`))
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`Python exited ${code}: ${stderr}`)) }
      pending.clear(); done(code)
    })
  })
  await ready
  const call = command => new Promise((done, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); child.kill(); reject(new Error('Python command expired')) }, 40000)
    pending.set(id, { resolve: done, reject, timer, method: command.method ?? command.kind }); child.stdin.write(JSON.stringify({ ...command, id }) + '\n')
  })
  return { child, call, exited, request: (method, params) => call({ method, params }), async close() {
    if (child.exitCode === null) await call({ kind: 'close' }); assert.equal(await exited, 0, stderr)
  } }
}

async function seedQuestion(spec) {
  const host = await h.openHost(spec, { bindings: { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
    script: async function* () {
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'question' }
      yield* action('agent_ask_user', { question: 'Which output format?', timeoutMs: 60000 })
    } }) } })
  try {
    await host.submitTask('writer', 'Confirm format'); await host.run()
    const root = host.report().members.find(member => member.agentKey === 'writer').agent.roots[0]
    return { rootId: root.id, wait: host.read().root('writer', root.id).waits[0].reference }
  } finally { await host.shutdown({ mode: 'drain' }) }
}

test('Python and Node API processes preserve File receipts, exact answers, messages and a fixed Session cut', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'python-control-')); let server, client
  try {
    const raw = JSON.parse(await readFile(new URL('../examples/host-config.json', import.meta.url), 'utf8'))
    raw.storage.root = join(directory, 'store'); raw.members[0].spec.nativeActions.push('agent_ask_user'); raw.members[0].model.runnerLimits.maxToolCalls = 1
    const spec = h.resolveHostConfig(h.decodeHostConfig(raw, directory)); await h.initializeHost(spec)
    const question = await seedQuestion(spec)
    server = await api(spec, raw, directory); client = await startClient(server.ready.listen.port)
    await client.request('input.answer', { agentKey: 'writer', submissionKey: 'answer', wait: question.wait, text: 'Markdown' })
    await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    assert.equal((await client.request('root.get', { agentKey: 'writer', rootId: question.rootId })).outcome, 'completed')
    const receipt = await client.request('input.submit', { agentKey: 'writer', submissionKey: 'stable-task', text: 'Research 中文' })
    assert.equal(receipt.reused, false)
    assert.equal((await client.request('input.submit', { agentKey: 'writer', submissionKey: 'stable-task', text: 'Research 中文' })).inputEventId, receipt.inputEventId)
    await assert.rejects(client.request('input.submit', { agentKey: 'writer', submissionKey: 'stable-task', text: 'changed' }), { code: 'API_KEY_CONFLICT', acceptance: 'not-accepted' })
    await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    const input = await client.request('input.get', { agentKey: 'writer', submissionKey: 'stable-task' })
    assert.equal((await client.request('root.wait', { agentKey: 'writer', rootId: input.rootId, timeoutMs: 100 })).status, 'condition-met')
    const message = await client.request('message.send', { agentKey: 'writer', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"evidence"}' })
    assert.equal(message.status, 'outbox-accepted', message.reason)
    await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    assert.equal((await client.request('message.wait', { agentKey: 'writer', messageId: message.messageId, direction: 'outbox', until: 'terminal', timeoutMs: 100 })).observation.fact.status, 'delivered')
    const reply = await client.request('message.reply', { agentKey: 'reviewer', messageId: message.messageId, type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"reviewed"}' })
    assert.equal(reply.status, 'outbox-accepted')
    await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    assert.equal((await client.request('message.get', { agentKey: 'reviewer', messageId: reply.messageId, direction: 'outbox' })).fact.status, 'delivered')
    const first = await client.request('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 5 })
    await client.request('input.submit', { agentKey: 'writer', submissionKey: 'new-cut', text: 'Explicit later task' })
    const pages = await client.call({ kind: 'events', params: { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 5, cursor: first.nextCursor } })
    assert.ok(pages.every(page => page.through === first.through)); assert.equal(pages.at(-1).hasMore, false)
    await client.close(); client = undefined
    assert.equal(server.status, 'ready')
    await server.shutdown({ mode: 'drain' }); server = undefined
    server = await api(spec, raw, directory); client = await startClient(server.ready.listen.port)
    const reused = await client.request('input.submit', { agentKey: 'writer', submissionKey: 'stable-task', text: 'Research 中文' })
    assert.equal(reused.reused, true); assert.equal(reused.inputEventId, receipt.inputEventId)
    await client.request('host.shutdown', { expectedInstanceId: server.ready.instanceId, mode: 'drain' }); await server.closed
  } finally {
    if (client !== undefined) await client.close()
    if (server !== undefined) await server.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Python controls the original Parent and reads retired Child facts', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'python-child-')); let server, client
  try {
    const raw = await subagentConfig(join(directory, 'store')), spec = h.resolveHostConfig(h.decodeHostConfig(raw, directory))
    await h.initializeHost(spec); const question = await seedQuestion(spec)
    server = await api(spec, raw, directory); client = await startClient(server.ready.listen.port)
    const spawn = { parentAgentKey: 'writer', parentRoot: question.rootId, requestKey: 'child', request: delegationRequest() }
    const receipt = await client.request('delegation.spawn', spawn)
    assert.equal((await client.request('delegation.spawn', spawn)).delegationId, receipt.delegationId)
    await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    const target = { parentAgentKey: 'writer', parentRoot: question.rootId, delegationId: receipt.delegationId }
    assert.equal((await client.request('delegation.get', target)).resultAvailable, true)
    assert.equal((await client.request('delegation.wait', { ...target, until: 'business', timeoutMs: 100 })).status, 'condition-met')
    await client.request('input.answer', { agentKey: 'writer', submissionKey: 'parent-answer', wait: question.wait, text: 'Confirmed' })
    await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    assert.equal((await client.request('delegation.wait', { ...target, until: 'closed', timeoutMs: 100 })).status, 'condition-met')
    const pages = await client.call({ kind: 'events', params: { target: { kind: 'child', ...target }, maxEvents: 10 } })
    assert.ok(pages.flatMap(page => page.events).some(event => event.type === 'subagent/child-bound'))
    await client.request('host.shutdown', { expectedInstanceId: server.ready.instanceId, mode: 'drain' }); await server.closed
  } finally {
    if (client !== undefined) await client.close()
    if (server !== undefined) await server.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Python projects Workflow completion and accepted artifact provenance', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'python-workflow-')); let server, client
  try {
    const raw = await workflowConfig(join(directory, 'store')), spec = resolveWorkflowConfig(raw)
    await h.initializeHost(spec); server = await api(spec, raw, directory); client = await startClient(server.ready.listen.port)
    await client.request('workflow.resume', { workflowKey: 'research', requestKey: 'resume', reason: '' })
    await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    assert.equal((await client.request('workflow.get', { workflowKey: 'research' })).closed, true)
    assert.equal((await client.request('workflow.wait', { workflowKey: 'research', until: 'closed', timeoutMs: 100 })).status, 'condition-met')
    assert.equal((await client.request('workflow.output', { workflowKey: 'research', nodeKey: 'writer' })).status, 'available')
    const pages = await client.call({ kind: 'events', params: { target: { kind: 'workflow', workflowKey: 'research' }, maxEvents: 100 } })
    const accepted = pages.flatMap(page => page.events).find(event => event.type === 'workflow/decision-committed' && event.payload.outcome === 'accepted')
    assert.ok(accepted)
    const artifact = await client.request('workflow.artifact', { workflowKey: 'research', artifactRef: accepted.payload.artifacts[0] })
    assert.equal(artifact.mediaType, 'text/plain'); assert.ok(artifact.text.length > 0)
    await client.request('host.shutdown', { expectedInstanceId: server.ready.instanceId, mode: 'drain' }); await server.closed
  } finally {
    if (client !== undefined) await client.close()
    if (server !== undefined) await server.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

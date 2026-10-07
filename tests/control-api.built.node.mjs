import assert from 'node:assert/strict'
import { spawn, fork } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { X509Certificate } from 'node:crypto'
import test from 'node:test'
import * as h from '../dist/index.js'
import { CONTROL_METHODS } from '../dist/protocol/index.js'
import { subagentConfig, delegationRequest, action } from '../examples/subagent-fixture.mjs'
import { workflowConfig, resolveWorkflowConfig } from '../examples/workflow-fixture.mjs'

const certRoot = fileURLToPath(new URL('./host/certs/', import.meta.url))
const bin = fileURLToPath(new URL('../dist/host/bin.js', import.meta.url))
const clientBin = fileURLToPath(new URL('./fixtures/control-client-child.mjs', import.meta.url))
const limits = { maxRequestBytes: 1048576, maxResponseBytes: 2097152, maxJsonDepth: 64, maxJsonNodes: 100000, maxHeaderBytes: 8192,
  maxPageEvents: 100, maxConnections: 16, maxPendingInputs: 4, maxPendingControls: 4, maxObservers: 4, maxPendingShutdowns: 4,
  requestReadTimeoutMs: 5000, responseWriteTimeoutMs: 5000, tlsHandshakeTimeoutMs: 5000, headersTimeoutMs: 5000,
  keepAliveTimeoutMs: 1000, maxWaitMs: 5000, observerScanIntervalMs: 5 }

async function files(directory, raw) {
  const fingerprint = new X509Certificate(await readFile(join(certRoot, 'client.pem'))).fingerprint256.replaceAll(':', '').toLowerCase()
  const api = { schemaVersion: 1, listenHost: '127.0.0.1', listenPort: 0,
    tls: { caFile: join(certRoot, 'ca.pem'), serverCertFile: join(certRoot, 'server.pem'), serverKeyFile: join(certRoot, 'server-key.pem') },
    principals: [{ principalKey: 'researcher', certificateFingerprints: [fingerprint], methods: [...CONTROL_METHODS],
      agentKeys: raw.members.filter(member => member.kind === 'local').map(member => member.agentKey),
      workflowKeys: raw.workflows?.kind === 'enabled' ? raw.workflows.definitions.map(entry => entry.definition.workflowKey) : [] }], limits }
  const hostPath = join(directory, 'host.json'), apiPath = join(directory, 'api.json')
  await writeFile(hostPath, JSON.stringify(raw)); await writeFile(apiPath, JSON.stringify(api))
  return { hostPath, apiPath }
}
async function startServer(paths) {
  const child = spawn(process.execPath, [bin, 'api', '--config', paths.hostPath, '--api-config', paths.apiPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr })))
  const ready = await new Promise((resolve, reject) => {
    let stdout = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`API ready expired: ${stderr}`)) }, 15000)
    const died = code => { clearTimeout(timer); reject(new Error(`API exited ${code}: ${stderr}`)) }
    child.once('exit', died)
    child.stdout.on('data', chunk => {
      stdout += chunk
      const newline = stdout.indexOf('\n'); if (newline < 0) return
      clearTimeout(timer); child.off('exit', died)
      try { resolve(JSON.parse(stdout.slice(0, newline))) } catch (error) { reject(error) }
    })
  })
  assert.equal(ready.kind, 'api-ready'); assert.equal(ready.drive, 'explicit-run')
  return { child, ready, exited }
}
async function startClient(directory, ready) {
  const config = { origin: `https://127.0.0.1:${ready.listen.port}`, serverName: 'localhost',
    tls: { ca: join(certRoot, 'ca.pem'), cert: join(certRoot, 'client.pem'), key: join(certRoot, 'client-key.pem') },
    limits: { maxRequestBytes: limits.maxRequestBytes, maxResponseBytes: limits.maxResponseBytes, maxJsonDepth: 64, maxJsonNodes: 100000,
      connectTimeoutMs: 5000, requestTimeoutMs: 15000, maxConnections: 4 } }
  const path = join(directory, 'client.json'); await writeFile(path, JSON.stringify(config))
  const child = fork(clientBin, [path], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
  const pending = new Map(); let next = 0
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`client exited ${code}: ${stderr}`)) }
    pending.clear(); resolve({ code, signal, stderr })
  }))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('client ready expired')) }, 15000)
    child.once('message', message => { clearTimeout(timer); assert.equal(message.kind, 'client-ready'); resolve() })
  })
  child.on('message', message => {
    const entry = pending.get(message.id); if (entry === undefined) return
    pending.delete(message.id); clearTimeout(entry.timer)
    if (message.error === undefined) entry.resolve(message.result)
    else entry.reject(Object.assign(new Error('Client call failed'), message.error))
  })
  const call = command => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('Client call expired')) }, 20000)
    pending.set(id, { resolve, reject, timer }); child.send({ ...command, id })
  })
  return { child, exited, call, request: (method, params) => call({ method, params }), close: () => call({ kind: 'close' }) }
}
async function stop(server, client) {
  await client.request('host.shutdown', { expectedInstanceId: server.ready.instanceId, mode: 'drain' })
  assert.equal((await server.exited).code, 0)
  await client.close(); assert.equal((await client.exited).code, 0)
}
async function seedQuestion(spec) {
  let calls = 0
  const host = await h.openHost(spec, { bindings: { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
    script: async function* () {
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'question' }
      if (++calls === 1) yield* action('agent_ask_user', { question: 'Which format?', timeoutMs: 60000 })
      else {
        yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'done' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      }
    } }) } })
  try {
    await host.submitTask('writer', 'Confirm format'); await host.run()
    const root = host.report().members.find(member => member.agentKey === 'writer').agent.roots[0]
    const wait = host.read().root('writer', root.id).waits[0].reference
    return { rootId: root.id, wait }
  } finally { await host.shutdown({ mode: 'drain' }) }
}

test('plain Node service and SDK persist tasks, survive lost response and crash, answer exact Wait, and exchange messages', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-process-')); let server, client
  try {
    const raw = JSON.parse(await readFile(new URL('../examples/host-config.json', import.meta.url), 'utf8')); raw.storage.root = join(directory, 'store')
    raw.members[0].spec.nativeActions.push('agent_ask_user'); raw.members[0].model.runnerLimits.maxToolCalls = 1
    const spec = h.resolveHostConfig(h.decodeHostConfig(raw, directory)); await h.initializeHost(spec)
    const question = await seedQuestion(spec), paths = await files(directory, raw)
    server = await startServer(paths); client = await startClient(directory, server.ready)
    const answer = await client.request('input.answer', { agentKey: 'writer', submissionKey: 'answer', wait: question.wait, text: 'Markdown' })
    await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    assert.equal((await client.request('root.get', { agentKey: 'writer', rootId: question.rootId })).outcome, 'completed')
    assert.deepEqual(await client.request('input.answer', { agentKey: 'writer', submissionKey: 'answer', wait: question.wait, text: 'Markdown' }), { ...answer, reused: true })
    await assert.rejects(client.request('input.answer', { agentKey: 'writer', submissionKey: 'late', wait: question.wait, text: 'Late' }), error => error.code === 'API_OPERATION_REJECTED')
    const sent = await client.request('message.send', { agentKey: 'writer', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"review"}' })
    assert.equal(sent.status, 'outbox-accepted'); await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    const reply = await client.request('message.reply', { agentKey: 'reviewer', messageId: sent.messageId, type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"reviewed"}' })
    assert.equal(reply.status, 'outbox-accepted'); await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    assert.equal((await client.request('message.get', { agentKey: 'writer', messageId: sent.messageId, direction: 'outbox' })).fact.status, 'delivered')
    await client.call({ kind: 'lost-input', params: { agentKey: 'writer', submissionKey: 'lost', text: 'Persist before lost response' } })
    const lost = await client.request('input.get', { agentKey: 'writer', submissionKey: 'lost' })
    assert.equal(lost.status, 'queued')
    const firstPage = await client.request('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 2 })
    server.child.kill('SIGKILL'); await server.exited
    await client.close(); await client.exited; client = undefined
    const marker = JSON.parse(await readFile(join(raw.storage.root, '.atomic-harness.lock'), 'utf8'))
    await h.unlockHostStorage(raw.storage.root, { predecessorStopped: true, expectedToken: marker.token })
    await h.recoverHost(spec, { predecessorStopped: true, maxRecoveryWrites: 64, maxJournalConflicts: 4 })
    const oldInstance = server.ready.instanceId
    server = await startServer(paths); client = await startClient(directory, server.ready)
    assert.notEqual(server.ready.instanceId, oldInstance)
    assert.equal((await client.request('input.submit', { agentKey: 'writer', submissionKey: 'lost', text: 'Persist before lost response' })).inputEventId, lost.inputEventId)
    const rest = await client.call({ kind: 'events', params: { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 5, cursor: firstPage.nextCursor } })
    assert.ok(rest.every(page => page.through === firstPage.through)); assert.equal(rest.at(-1).hasMore, false)
    await stop(server, client); server = undefined; client = undefined
  } finally {
    if (client !== undefined) { if (client.child.connected) await client.close().catch(() => undefined); await client.exited }
    if (server !== undefined && server.child.exitCode === null) { server.child.kill(); await server.exited }
    await rm(directory, { recursive: true, force: true })
  }
})

test('plain Node SDK controls original Parent and reads retired Child events', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-child-')); let server, client
  try {
    const raw = await subagentConfig(join(directory, 'store'))
    const spec = h.resolveHostConfig(h.decodeHostConfig(raw, directory)); await h.initializeHost(spec)
    const question = await seedQuestion(spec), paths = await files(directory, raw)
    server = await startServer(paths); client = await startClient(directory, server.ready)
    const request = delegationRequest()
    const receipt = await client.request('delegation.spawn', { parentAgentKey: 'writer', parentRoot: question.rootId, requestKey: 'spawn', request })
    assert.equal((await client.request('delegation.spawn', { parentAgentKey: 'writer', parentRoot: question.rootId, requestKey: 'spawn', request })).delegationId, receipt.delegationId)
    await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    const query = { parentAgentKey: 'writer', parentRoot: question.rootId, delegationId: receipt.delegationId }
    const inspected = await client.request('delegation.get', query)
    assert.equal(inspected.resultAvailable, true)
    assert.equal((await client.request('delegation.wait', { ...query, until: 'business', timeoutMs: 100 })).status, 'condition-met')
    await client.request('input.answer', { agentKey: 'writer', submissionKey: 'parent-answer', wait: question.wait, text: 'Confirmed' })
    await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    assert.equal((await client.request('delegation.wait', { ...query, until: 'closed', timeoutMs: 100 })).status, 'condition-met')
    const pages = await client.call({ kind: 'events', params: { target: { kind: 'child', ...query }, maxEvents: 10 } })
    assert.ok(pages.flatMap(page => page.events).some(event => event.type === 'subagent/child-bound'))
    await stop(server, client); server = undefined; client = undefined
  } finally {
    if (client !== undefined) { if (client.child.connected) await client.close().catch(() => undefined); await client.exited }
    if (server !== undefined && server.child.exitCode === null) { server.child.kill(); await server.exited }
    await rm(directory, { recursive: true, force: true })
  }
})

test('plain Node SDK resumes Workflow and verifies accepted output/artifact provenance', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-workflow-')); let server, client
  try {
    const raw = await workflowConfig(join(directory, 'store'))
    const spec = resolveWorkflowConfig(raw); await h.initializeHost(spec)
    const paths = await files(directory, raw)
    server = await startServer(paths); client = await startClient(directory, server.ready)
    await client.request('workflow.resume', { workflowKey: 'research', requestKey: 'resume', reason: '' })
    await client.request('host.run', { expectedInstanceId: server.ready.instanceId })
    const observation = await client.request('workflow.get', { workflowKey: 'research' })
    assert.equal(observation.closed, true)
    assert.equal((await client.request('workflow.wait', { workflowKey: 'research', until: 'closed', timeoutMs: 100 })).status, 'condition-met')
    const output = await client.request('workflow.output', { workflowKey: 'research', nodeKey: 'writer' })
    assert.equal(output.status, 'available')
    const eventPages = await client.call({ kind: 'events', params: { target: { kind: 'workflow', workflowKey: 'research' }, maxEvents: 100 } })
    const decision = eventPages.flatMap(page => page.events).find(event => event.type === 'workflow/decision-committed' && event.payload.outcome === 'accepted')
    assert.ok(decision)
    const artifact = await client.request('workflow.artifact', { workflowKey: 'research', artifactRef: decision.payload.artifacts[0] })
    assert.ok(artifact.text.length > 0); assert.equal(artifact.mediaType, 'text/plain')
    await stop(server, client); server = undefined; client = undefined
  } finally {
    if (client !== undefined) { if (client.child.connected) await client.close().catch(() => undefined); await client.exited }
    if (server !== undefined && server.child.exitCode === null) { server.child.kill(); await server.exited }
    await rm(directory, { recursive: true, force: true })
  }
})

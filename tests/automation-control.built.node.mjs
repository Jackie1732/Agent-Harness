import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { X509Certificate } from 'node:crypto'
import { createServer, request } from 'node:https'
import test from 'node:test'
import { initializeHost, decodeHostConfig, resolveHostConfig } from '../dist/host/index.js'
import { openHarnessApiServer, decodeApiConfig, resolveApiConfig } from '../dist/api/index.js'
import { CONTROL_METHODS } from '../dist/protocol/index.js'
import { createHarnessClient } from '../dist/client/index.js'

const bin = fileURLToPath(new URL('../dist/host/bin.js', import.meta.url))
const childPath = fileURLToPath(new URL('./automation/automation-child.mjs', import.meta.url))
const certificates = fileURLToPath(new URL('./host/certs/', import.meta.url))
const token = 'local-automation-test-token-0123456789'
const apiLimits = { maxRequestBytes: 1048576, maxResponseBytes: 2097152, maxJsonDepth: 64, maxJsonNodes: 100000, maxHeaderBytes: 8192,
  maxPageEvents: 100, maxConnections: 16, maxPendingInputs: 4, maxPendingControls: 4, maxObservers: 4, maxPendingShutdowns: 4,
  requestReadTimeoutMs: 5000, responseWriteTimeoutMs: 5000, tlsHandshakeTimeoutMs: 5000, headersTimeoutMs: 5000, keepAliveTimeoutMs: 1000,
  maxWaitMs: 5000, observerScanIntervalMs: 5 }
async function cli(args) {
  const child = spawn(process.execPath, [bin, 'automate', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr })) })
}
async function start(path) {
  const child = fork(childPath, [path], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, AUTOMATION_TEST_TOKEN: token } })
  let stderr = '', sequence = 0; const pending = new Map()
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`automation child exited: ${stderr}`)) } pending.clear(); resolve({ code, signal })
  }))
  child.on('message', message => {
    const entry = pending.get(message.id)
    if (entry !== undefined) { clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message.status) }
  })
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`automation ready expired: ${stderr}`)) }, 15000)
    const message = value => { if (value.kind === 'ready') { clearTimeout(timer); child.off('message', message); resolve(value.ready) }
      else if (value.kind === 'error') { clearTimeout(timer); child.off('message', message); reject(new Error(value.code)) } }
    child.on('message', message); child.once('exit', () => { clearTimeout(timer); reject(new Error(`automation exited before ready: ${stderr}`)) })
  })
  return { child, ready, exited,
    status() { return new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('automation status expired')) }, 5000)
      pending.set(id, { resolve, reject, timer }); child.send({ kind: 'status', id }) }) },
    async dispose() { if (child.exitCode === null && child.signalCode === null) { child.send({ kind: 'dispose' }); assert.equal((await exited).code, 0) } } }
}
async function eventually(predicate, timeoutMs = 10000) { const end = Date.now() + timeoutMs; while (!await predicate()) {
  if (Date.now() >= end) throw new Error('built automation condition expired'); await new Promise(resolve => setTimeout(resolve, 20)) } }
async function post(port, body, ca) {
  const bytes = Buffer.from(JSON.stringify(body))
  return await new Promise((resolve, reject) => { const outgoing = request({ host: '127.0.0.1', port, servername: 'localhost', ca, method: 'POST', path: '/automation/v1/webhooks/review',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': bytes.length } }, incoming => {
    const parts = []; incoming.on('data', chunk => parts.push(chunk)); incoming.once('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) }))
  }); outgoing.once('error', reject); outgoing.end(bytes) })
}
async function proxy(targetPort, tls, serverTls) {
  const sockets = new Set(), methods = []; let heldResolve, release
  const held = new Promise(resolve => { heldResolve = resolve }), released = new Promise(resolve => { release = resolve })
  const server = createServer({ ...serverTls, ca: tls.ca, requestCert: true, rejectUnauthorized: true }, (incoming, response) => {
    const parts = []; incoming.on('data', chunk => parts.push(chunk)); incoming.once('end', () => {
      const body = Buffer.concat(parts), method = JSON.parse(body.toString()).method; methods.push(method)
      const outgoing = request({ ...tls, host: '127.0.0.1', port: targetPort, servername: 'localhost', method: 'POST', path: incoming.url,
        headers: { 'content-type': 'application/json', 'content-length': body.length } }, forwarded => {
        const result = []; forwarded.on('data', chunk => result.push(chunk)); forwarded.once('end', () => {
          const emit = async () => { if (method === 'host.run') { heldResolve(); await released }
            response.writeHead(forwarded.statusCode, { 'content-type': 'application/json' }); response.end(Buffer.concat(result)) }
          void emit().catch(() => response.destroy())
        })
      }); outgoing.once('error', () => response.destroy()); outgoing.end(body)
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { port: server.address().port, methods, held, release,
    async dispose() { release(); for (const socket of sockets) socket.destroy(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}

test('plain Node automation CLI imports declared protocol formats and rejects invalid usage', async () => {
  const help = await cli(['--help']); assert.equal(help.code, 0); assert.match(help.stdout, /acknowledge-run-unknown/)
  const invalid = await cli(['--unknown']); assert.equal(invalid.code, 2); assert.equal(JSON.parse(invalid.stderr).code, 'AUTOMATION_CONFIG_INVALID')
})
test('actual automation process crash retains run intent and residual lock; explicit unlock/ack permits new triggers without replay', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-built-'))
  let service, forwarding, worker, client
  try {
    const [ca, cert, key, serverCert, serverKey] = await Promise.all(['ca.pem', 'client.pem', 'client-key.pem', 'server.pem', 'server-key.pem'].map(name => readFile(join(certificates, name))))
    const tls = { ca, cert, key }, raw = JSON.parse(await readFile(new URL('../examples/host-config.json', import.meta.url), 'utf8')); raw.storage.root = join(directory, 'host')
    const host = resolveHostConfig(decodeHostConfig(raw, directory)); await initializeHost(host)
    const api = resolveApiConfig(decodeApiConfig({ schemaVersion: 1, listenHost: '127.0.0.1', listenPort: 0,
      tls: { caFile: join(certificates, 'ca.pem'), serverCertFile: join(certificates, 'server.pem'), serverKeyFile: join(certificates, 'server-key.pem') },
      principals: [{ principalKey: 'researcher', certificateFingerprints: [new X509Certificate(cert).fingerprint256], methods: [...CONTROL_METHODS], agentKeys: ['writer', 'reviewer'], workflowKeys: [] }], limits: apiLimits }), host, directory)
    service = await openHarnessApiServer({ host, api, credentials: {} })
    forwarding = await proxy(service.ready.listen.port, tls, { cert: serverCert, key: serverKey })
    const settings = JSON.parse(await readFile(new URL('../examples/automation-config.json', import.meta.url), 'utf8'))
    settings.hostKey = raw.hostKey; settings.journal.root = join(directory, 'automation'); settings.webhook.listenPort = 0
    settings.client.origin = `https://127.0.0.1:${forwarding.port}`; settings.client.tls = { caFile: join(certificates, 'ca.pem'), certFile: join(certificates, 'client.pem'), keyFile: join(certificates, 'client-key.pem') }
    settings.webhook.tls = { certFile: join(certificates, 'server.pem'), keyFile: join(certificates, 'server-key.pem') }; settings.webhook.bearerTokenEnv = 'AUTOMATION_TEST_TOKEN'
    settings.jobs = [{ jobKey: 'review', agentKey: 'writer', trigger: { kind: 'webhook' } }]
    const path = join(directory, 'automation.json'); await writeFile(path, JSON.stringify(settings))
    worker = await start(path)
    const accepted = await post(worker.ready.listen.port, { eventId: 'old-run', text: 'research' }, ca); assert.equal(accepted.status, 202)
    const triggerKey = accepted.body.trigger.triggerKey; await forwarding.held
    assert.equal(worker.child.kill('SIGKILL'), true); await worker.exited; forwarding.release()
    const lock = JSON.parse(await readFile(join(settings.journal.root, '.atomic-harness.lock'), 'utf8'))
    assert.equal(lock.processId, worker.child.pid)
    const locked = await cli(['--config', path, '--acknowledge-run-unknown', triggerKey]); assert.notEqual(locked.code, 0)
    const unlocked = await cli(['--config', path, '--unlock', '--predecessor-stopped', '--expected-token', lock.token]); assert.equal(unlocked.code, 0)
    worker = await start(path); assert.equal((await worker.status()).driverBlocked, true)
    assert.equal((await post(worker.ready.listen.port, { eventId: 'new-run', text: 'another task' }, ca)).status, 202)
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(forwarding.methods.filter(method => method === 'host.run').length, 1)
    assert.equal(forwarding.methods.filter(method => method === 'input.submit').length, 1)
    await worker.dispose(); worker = undefined
    const before = forwarding.methods.length, acknowledged = await cli(['--config', path, '--acknowledge-run-unknown', triggerKey])
    assert.equal(acknowledged.code, 0); assert.equal(JSON.parse(acknowledged.stdout).runAcceptance, 'unknown'); assert.equal(forwarding.methods.length, before)
    worker = await start(path)
    await eventually(async () => (await worker.status()).triggers.filter(trigger => trigger.execution === 'closed').length === 2)
    const final = await worker.status(), old = final.triggers.find(trigger => trigger.triggerKey === triggerKey)
    assert.equal(final.driverBlocked, false); assert.equal(old.runAcceptance, 'unknown'); assert.equal(old.runUnknownAcknowledged, true)
    assert.equal(forwarding.methods.filter(method => method === 'host.run').length, 2); assert.equal(forwarding.methods.filter(method => method === 'input.submit').length, 2)
    await worker.dispose(); worker = undefined
    client = createHarnessClient({ origin: `https://127.0.0.1:${service.ready.listen.port}`, serverName: 'localhost', tls,
      limits: settings.client.limits }); assert.equal((await client.request('host.status', {})).hostStatus, 'ready')
  } finally {
    if (worker?.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill('SIGKILL'); await worker.exited }
    await client?.close(); await forwarding?.dispose(); await service?.dispose(); await rm(directory, { recursive: true, force: true })
  }
})

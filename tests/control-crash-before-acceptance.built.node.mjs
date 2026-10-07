import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { decodeHostConfig, resolveHostConfig, initializeHost, unlockHostStorage, recoverHost } from '../dist/host/index.js'
import { CONTROL_METHODS } from '../dist/protocol/index.js'
import { createHarnessClient } from '../dist/client/index.js'

const certRoot = fileURLToPath(new URL('./host/certs/', import.meta.url))
const bin = fileURLToPath(new URL('../dist/host/bin.js', import.meta.url))
const limits = { maxRequestBytes: 1048576, maxResponseBytes: 2097152, maxJsonDepth: 64, maxJsonNodes: 100000,
  maxHeaderBytes: 8192, maxPageEvents: 100, maxConnections: 8, maxPendingInputs: 4, maxPendingControls: 4,
  maxObservers: 4, maxPendingShutdowns: 4, requestReadTimeoutMs: 5000, responseWriteTimeoutMs: 5000,
  tlsHandshakeTimeoutMs: 5000, headersTimeoutMs: 5000, keepAliveTimeoutMs: 1000, maxWaitMs: 5000, observerScanIntervalMs: 5 }

async function start(hostPath, apiPath) {
  const child = spawn(process.execPath, [bin, 'api', '--config', hostPath, '--api-config', apiPath],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr })))
  try {
    const ready = await new Promise((resolve, reject) => {
      let stdout = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`API ready expired: ${stderr}`)) }, 15000)
      const died = code => { clearTimeout(timer); reject(new Error(`API exited before ready ${code}: ${stderr}`)) }
      child.once('exit', died)
      child.stdout.on('data', chunk => {
        stdout += chunk
        const newline = stdout.indexOf('\n')
        if (newline < 0) return
        clearTimeout(timer); child.off('exit', died)
        try { resolve(JSON.parse(stdout.slice(0, newline))) } catch (error) { reject(error) }
      })
    })
    assert.equal(ready.kind, 'api-ready'); assert.equal(ready.drive, 'explicit-run')
    return { child, ready, exited }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    throw error
  }
}

test('a real service crash before any submission leaves the key absent and its first later acceptance unique', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-before-acceptance-'))
  let server, client
  try {
    const raw = JSON.parse(await readFile(new URL('../examples/host-config.json', import.meta.url), 'utf8'))
    raw.storage.root = join(directory, 'store')
    const spec = resolveHostConfig(decodeHostConfig(raw, directory))
    await initializeHost(spec)
    const [ca, certificate, key] = await Promise.all(['ca.pem', 'client.pem', 'client-key.pem'].map(name => readFile(join(certRoot, name))))
    const api = { schemaVersion: 1, listenHost: '127.0.0.1', listenPort: 0,
      tls: { caFile: join(certRoot, 'ca.pem'), serverCertFile: join(certRoot, 'server.pem'), serverKeyFile: join(certRoot, 'server-key.pem') },
      principals: [{ principalKey: 'researcher', certificateFingerprints: [new X509Certificate(certificate).fingerprint256],
        methods: [...CONTROL_METHODS], agentKeys: ['writer', 'reviewer'], workflowKeys: [] }], limits }
    const hostPath = join(directory, 'host.json'), apiPath = join(directory, 'api.json')
    await writeFile(hostPath, JSON.stringify(raw)); await writeFile(apiPath, JSON.stringify(api))
    server = await start(hostPath, apiPath)
    const originalInstance = server.ready.instanceId
    // No control client or business submission exists before this process exit.
    assert.equal(server.child.kill('SIGKILL'), true)
    await server.exited
    const marker = JSON.parse(await readFile(join(raw.storage.root, '.atomic-harness.lock'), 'utf8'))
    assert.equal(marker.instanceId, originalInstance)
    assert.equal(marker.processId, server.child.pid)
    await unlockHostStorage(raw.storage.root, { predecessorStopped: true, expectedToken: marker.token })
    await recoverHost(spec, { predecessorStopped: true, maxRecoveryWrites: 64, maxJournalConflicts: 4 })
    server = await start(hostPath, apiPath)
    assert.notEqual(server.ready.instanceId, originalInstance)
    client = createHarnessClient({ origin: `https://127.0.0.1:${server.ready.listen.port}`, serverName: 'localhost',
      tls: { ca, cert: certificate, key }, limits: { maxRequestBytes: limits.maxRequestBytes, maxResponseBytes: limits.maxResponseBytes,
        maxJsonDepth: 64, maxJsonNodes: 100000, connectTimeoutMs: 5000, requestTimeoutMs: 10000, maxConnections: 2 } })
    const submission = { agentKey: 'writer', submissionKey: 'before-acceptance', text: 'First accepted after the restart' }
    await assert.rejects(client.request('input.get', { agentKey: submission.agentKey, submissionKey: submission.submissionKey }),
      error => error.code === 'API_TARGET_NOT_FOUND' && error.acceptance === 'not-applicable')
    const receipt = await client.request('input.submit', submission)
    assert.equal(receipt.reused, false)
    assert.deepEqual(await client.request('input.submit', submission), { ...receipt, reused: true })
    const accepted = []
    for await (const page of client.events({ target: { kind: 'member', agentKey: 'writer' }, maxEvents: 3 })) {
      accepted.push(...page.events.filter(event => event.type === 'agent/input-accepted' && event.payloadVersion === 2
        && event.payload.submission.namespace === 'api:researcher' && event.payload.submission.key === submission.submissionKey))
    }
    assert.equal(accepted.length, 1)
    assert.equal(accepted[0].eventId, receipt.inputEventId)
    assert.equal((await client.request('input.get', { agentKey: submission.agentKey, submissionKey: submission.submissionKey })).status, 'queued')
    await client.request('host.shutdown', { expectedInstanceId: server.ready.instanceId, mode: 'drain' })
    assert.equal((await server.exited).code, 0)
    server = undefined
  } finally {
    await client?.dispose()
    if (server !== undefined && server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill('SIGKILL'); await server.exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})

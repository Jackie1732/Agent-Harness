import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { initializeHost, decodeHostConfig, resolveHostConfig } from '@atomic-harness/core/host'
import { decodeApiConfig, resolveApiConfig, openHarnessApiServer } from '@atomic-harness/core/api'
import { CONTROL_METHODS } from '@atomic-harness/core/protocol'
import { createHarnessClient } from '@atomic-harness/core/client'
import { decodeUiConfig, resolveUiConfig, openHarnessUiServer } from '@atomic-harness/core/ui'

const raw = JSON.parse(await readFile('host.json', 'utf8'))
raw.storage.root = resolve('sessions')
const host = resolveHostConfig(decodeHostConfig(raw, process.cwd()))
await initializeHost(host)
const cert = await readFile('client.pem')
const limits = { maxRequestBytes: 1048576, maxJsonDepth: 48, maxJsonNodes: 100000, maxHeaderBytes: 8192,
  maxResponseBytes: 4194304, maxPageEvents: 10, maxConnections: 16, maxPendingInputs: 4, maxPendingControls: 4,
  maxObservers: 4, maxPendingShutdowns: 4, requestReadTimeoutMs: 10000, responseWriteTimeoutMs: 10000,
  tlsHandshakeTimeoutMs: 5000, headersTimeoutMs: 5000, keepAliveTimeoutMs: 1000, maxWaitMs: 10000, observerScanIntervalMs: 10 }
const api = resolveApiConfig(decodeApiConfig({ schemaVersion: 1, listenHost: '127.0.0.1', listenPort: 0,
  tls: { caFile: 'ca.pem', serverCertFile: 'server.pem', serverKeyFile: 'server-key.pem' },
  principals: [{ principalKey: 'research', certificateFingerprints: [new X509Certificate(cert).fingerprint256], methods: [...CONTROL_METHODS], agentKeys: ['writer', 'reviewer'], workflowKeys: [] }], limits }), host, process.cwd())
const service = await openHarnessApiServer({ host, api, credentials: {} })
const client = createHarnessClient({ origin: `https://127.0.0.1:${service.ready.listen.port}`, serverName: 'localhost',
  tls: { ca: await readFile('ca.pem'), cert, key: await readFile('client-key.pem') },
  limits: { maxRequestBytes: 1048576, maxResponseBytes: 4194304, maxJsonDepth: 48, maxJsonNodes: 100000,
    connectTimeoutMs: 5000, requestTimeoutMs: 20000, maxConnections: 8 } })
let ui
try {
  ui = await openHarnessUiServer({ password: 'offline-test-password', config: resolveUiConfig(decodeUiConfig({
    schemaVersion: 1, listenPort: 0, passwordEnv: 'ATOMIC_UI_PASSWORD', memberKeys: ['writer'], workflowKeys: [],
    remote: { origin: `https://127.0.0.1:${service.ready.listen.port}`, serverName: 'localhost', caFile: 'ca.pem', certFile: 'client.pem', keyFile: 'client-key.pem',
      limits: { maxRequestBytes: 1048576, maxResponseBytes: 4194304, maxJsonDepth: 48, maxJsonNodes: 100000,
        connectTimeoutMs: 5000, requestTimeoutMs: 20000, maxConnections: 4 } },
    limits: { maxRequestBytes: 1048576, maxJsonDepth: 48, maxJsonNodes: 100000, maxHeaderBytes: 8192, maxConnections: 8,
      maxPendingRequests: 4, requestReadTimeoutMs: 5000, responseWriteTimeoutMs: 5000, headersTimeoutMs: 5000, keepAliveTimeoutMs: 1000, sessionTimeoutMs: 60000 },
  }), process.cwd()) })
  const page = await fetch(ui.ready.url)
  assert.match(page.headers.get('content-type'), /text\/html/); assert.match(await page.text(), /app\.mjs/)
  const login = await fetch(`${ui.ready.url}/api/login`, { method: 'POST', headers: { origin: ui.ready.url, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'offline-test-password' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const observation = await fetch(`${ui.ready.url}/api/control`, { method: 'POST', headers: { origin: ui.ready.url, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'agent.get', params: { agentKey: 'writer' } }) })
  assert.equal((await observation.json()).kind, 'result')
  const status = await client.request('host.status', {})
  const receipt = await client.request('input.submit', { agentKey: 'writer', submissionKey: 'offline-paper', text: 'Analyze a paper' })
  assert.equal(receipt.reused, false)
  assert.equal((await client.request('input.submit', { agentKey: 'writer', submissionKey: 'offline-paper', text: 'Analyze a paper' })).reused, true)
  await client.request('host.run', { expectedInstanceId: status.instanceId })
  const input = await client.request('input.get', { agentKey: 'writer', submissionKey: 'offline-paper' })
  assert.ok(input.rootId)
  const result = await client.request('root.get', { agentKey: 'writer', rootId: input.rootId })
  assert.equal(result.outcome, 'completed'); assert.equal(result.final.text, 'writer answer')
  let count = 0
  for await (const page of client.events({ target: { kind: 'member', agentKey: 'writer' }, maxEvents: 3 })) count += page.events.length
  assert.ok(count > 3)
  const closed = await client.request('host.shutdown', { expectedInstanceId: status.instanceId, mode: 'drain' })
  assert.equal(closed.hostStatus, 'stopped')
  console.log(JSON.stringify({ task: 'completed', durableReuse: true, pages: count, shutdown: closed.mode }))
} finally { await ui?.dispose(); await client.dispose(); await service.dispose() }

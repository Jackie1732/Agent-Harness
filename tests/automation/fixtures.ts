import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request, createServer } from 'node:https'
import type { Server } from 'node:https'
import type { Duplex } from 'node:stream'
import type { ControlMethod } from '../../src/protocol/index.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import { decodeAutomationConfig } from '../../src/automation/config.js'
import type { AutomationConfig } from '../../src/automation/config-types.js'
import { apiConfig, certificateDirectory, clientOptions } from '../api/fixtures.js'
import { hostConfig } from '../host/fixtures.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'

export const bearerToken = 'local-automation-test-token-0123456789'
export function config(directory: string, port: number): AutomationConfig {
  return decodeAutomationConfig({ schemaVersion: 1, automationKey: 'research', hostKey: 'test-host',
    journal: { root: join(directory, 'automation'), sessionId: '40000000-0000-4000-8000-000000000014', maxRecordBytes: 4194304, maxTriggers: 20, maxEvents: 1000 },
    client: { origin: `https://127.0.0.1:${port}`, serverName: 'localhost', tls: { caFile: `${certificateDirectory}ca.pem`, certFile: `${certificateDirectory}client.pem`, keyFile: `${certificateDirectory}client-key.pem` },
      limits: { maxRequestBytes: 1048576, maxResponseBytes: 2097152, maxJsonDepth: 64, maxJsonNodes: 100000, connectTimeoutMs: 3000, requestTimeoutMs: 20000, maxConnections: 1 } },
    webhook: { listenHost: '127.0.0.1', listenPort: 0, tls: { certFile: `${certificateDirectory}server.pem`, keyFile: `${certificateDirectory}server-key.pem` }, bearerTokenEnv: 'AUTOMATION_TEST_TOKEN' },
    limits: { maxRequestBytes: 65536, maxResponseBytes: 2097152, maxJsonDepth: 32, maxJsonNodes: 10000, maxHeaderBytes: 8192, maxConnections: 8, maxPendingRequests: 4, maxQueued: 4,
      requestReadTimeoutMs: 2000, responseWriteTimeoutMs: 2000, headersTimeoutMs: 2000, tlsHandshakeTimeoutMs: 2000, keepAliveTimeoutMs: 100, observeIntervalMs: 250 },
    jobs: [{ jobKey: 'review', agentKey: 'writer', trigger: { kind: 'webhook' } }] })
}
export async function setup(question?: { readonly submissionKey: string; readonly text: string }) {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-automation-'))
  const raw = hostConfig(join(directory, 'host'))
  if (question !== undefined) {
    const member = (raw.members as Array<Record<string, unknown>>)[0]!
    member.spec = { ...(member.spec as object), nativeActions: ['agent_ask_user'] }
    const model = member.model as Record<string, unknown>; model.runnerLimits = { ...(model.runnerLimits as object), maxToolCalls: 1 }
  }
  const host = resolveHostConfig(decodeHostConfig(raw, directory))
  await initializeHost(host)
  let seededReceipt
  if (question !== undefined) {
    const seeded = await openHost(host, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* () {
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'question' }
        yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'ask' }
        yield { kind: 'arguments-delta', index: 0, text: '{"question":"Which format?","timeoutMs":60000}' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } }) } })
    try {
      seededReceipt = await seeded.submitKeyedInput('writer', { kind: 'task', text: question.text, originLabel: 'api:researcher' }, { namespace: 'api:researcher', key: question.submissionKey })
      await seeded.run()
    } finally { await seeded.shutdown({ mode: 'drain' }) }
  }
  const service = await openHarnessApiServer({ host, api: resolveApiConfig(decodeApiConfig(await apiConfig()), host, directory), credentials: {} })
  return { directory, host, service, seededReceipt, config: config(directory, service.ready.listen.port),
    async dispose() { await service.dispose(); await rm(directory, { recursive: true, force: true }) } }
}
export async function eventually(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!predicate()) { if (Date.now() >= end) throw new Error('Automation fixture condition expired'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
export async function webhookRequest(port: number, body: unknown, token = bearerToken, path = '/automation/v1/webhooks/review', method = 'POST') {
  const ca = await readFile(`${certificateDirectory}ca.pem`), bytes = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body))
  return await new Promise<{ readonly status: number; readonly body: unknown }>((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, servername: 'localhost', ca, method, path,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': method === 'GET' ? 0 : bytes.length } }, incoming => {
      const chunks: Buffer[] = []; incoming.on('data', (chunk: Buffer) => chunks.push(chunk)); incoming.once('error', reject)
      incoming.once('end', () => resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as unknown }))
    })
    outgoing.once('error', reject); outgoing.end(method === 'GET' ? undefined : bytes)
  })
}
/** The proxy forwards real mTLS RPC and can discard a completed domain response or hold its acknowledgement. */
export async function faultProxy(targetPort: number, options: { readonly lose?: ControlMethod; readonly hold?: ControlMethod } = {}) {
  const tls = await clientOptions(targetPort), [cert, key] = await Promise.all(['server.pem', 'server-key.pem'].map(name => readFile(`${certificateDirectory}${name}`)))
  const sockets = new Set<Duplex>(), methods: ControlMethod[] = []
  let lost = false, heldResolve!: () => void, release!: () => void
  const held = new Promise<void>(resolve => { heldResolve = resolve }), released = new Promise<void>(resolve => { release = resolve })
  const server: Server = createServer({ ca: tls.tls.ca, cert: cert!, key: key!, requestCert: true, rejectUnauthorized: true }, (incoming, response) => {
    const chunks: Buffer[] = []; incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.once('end', () => {
      const body = Buffer.concat(chunks), method = (JSON.parse(body.toString()) as { method: ControlMethod }).method; methods.push(method)
      const outgoing = request({ host: '127.0.0.1', port: targetPort, servername: 'localhost', ...tls.tls, method: 'POST', path: incoming.url!,
        headers: { 'content-type': 'application/json', 'content-length': body.length } }, forwarded => {
        const parts: Buffer[] = []; forwarded.on('data', (chunk: Buffer) => parts.push(chunk))
        forwarded.once('end', () => {
          const send = async (): Promise<void> => {
            if (options.hold === method) { heldResolve(); await released }
            if (options.lose === method && !lost) { lost = true; response.destroy(); return }
            response.writeHead(forwarded.statusCode!, { 'content-type': 'application/json' }); response.end(Buffer.concat(parts))
          }
          void send().catch(() => response.destroy())
        })
      })
      outgoing.once('error', () => response.destroy()); outgoing.end(body)
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as { port: number }).port, methods, held, release,
    async dispose() { release(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))) } }
}

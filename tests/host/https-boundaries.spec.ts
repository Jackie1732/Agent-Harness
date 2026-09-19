import { readFile } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { request, createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { RequestOptions } from 'node:https'
import { expect, it } from 'vitest'
import { CommunicationService, createHttpsMessageServer, createHttpsMessageClientTransport, createInProcessMessageTransport, createSessionDirectory, parseChannelId } from '../../src/index.js'
import { createRepository, limits, messageCatalog, requestMessage } from '../communication/fixtures.js'

const transportLimits = { maxHeaderBytes: 2048, maxBodyBytes: 2048, maxResponseBytes: 2048,
  maxConnections: 8, maxInFlightRequests: 4, handshakeTimeoutMs: 2000, headersTimeoutMs: 2000,
  bodyTimeoutMs: 2000, requestTimeoutMs: 2000, idleTimeoutMs: 100 }
const cert = (name: string) => readFile(new URL(`./certs/${name}.pem`, import.meta.url))

function post(origin: string, tls: RequestOptions, body: string | readonly string[], headers = {}) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const outgoing = request(new URL('/ah-message/v1/deliver', origin), { method: 'POST', agent: false,
      servername: 'localhost', ...tls, headers: { 'content-type': 'application/json', 'x-atomic-host-key': 'sender', ...headers } }, response => {
      let value = ''
      response.on('data', chunk => { value += chunk.toString() })
      response.once('end', () => resolve({ status: response.statusCode, body: value }))
      response.once('error', reject)
    })
    outgoing.once('error', reject)
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('test request timeout')))
    if (typeof body === 'string') outgoing.end(body)
    else { for (const chunk of body) outgoing.write(chunk); outgoing.end() }
  })
}

it('rejects unauthenticated identities and bounded wire violations without accepting an Inbox item', async () => {
  const [ca, serverCert, serverKey, clientCert, clientKey, otherCert, otherKey] = await Promise.all(
    ['ca', 'server', 'server-key', 'client', 'client-key', 'client-b', 'client-b-key'].map(cert))
  const repository = createRepository()
  const directory = createSessionDirectory()
  const local = createInProcessMessageTransport(directory)
  const service = new CommunicationService({ directory, transport: local, limits })
  const sender = await service.attach(await repository.create(), { catalog: messageCatalog,
    policy: { canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }) } })
  const receiver = await service.attach(await repository.create(), { catalog: messageCatalog,
    policy: { canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }) } })
  await sender.send(requestMessage, { kind: 'root', recipient: receiver.address,
    channelId: parseChannelId('20000000-0000-4000-8000-000000000101') }, { text: 'wire' })
  const envelope = sender.snapshot().outbox[0]!.envelope
  const senders = new Set([sender.address])
  const server = await createHttpsMessageServer({ directory, host: '127.0.0.1', port: 0,
    tls: { ca: ca!, cert: serverCert!, key: serverKey! }, limits: transportLimits,
    peers: [{ hostKey: 'sender', fingerprint256: new X509Certificate(clientCert!).fingerprint256, senders }] })
  const tls = { ca: ca!, cert: clientCert!, key: clientKey! }
  const body = JSON.stringify({ protocolVersion: 1, envelope })
  try {
    await expect(post(server.origin, { ca: ca! }, body)).rejects.toBeDefined()
    await expect(post(server.origin, { ...tls, ca: clientCert! }, body)).rejects.toBeDefined()
    await expect(post(server.origin, { ...tls, servername: 'wrong-server.invalid' }, body)).rejects.toBeDefined()
    expect((await post(server.origin, { ca: ca!, cert: otherCert!, key: otherKey! }, body)).status).toBe(403)
    expect((await post(server.origin, tls, body, { 'x-atomic-host-key': 'forged' })).status).toBe(403)
    expect((await post(server.origin, tls, JSON.stringify({ protocolVersion: 2, envelope }))).status).toBe(400)
    expect((await post(server.origin, tls, body, { 'content-type': 'text/html' })).status).toBe(415)
    expect((await post(server.origin, tls, body, { 'content-encoding': 'gzip' })).status).toBe(400)
    expect((await post(server.origin, tls, body, { 'content-length': '1000000' })).status).toBe(413)
    expect((await post(server.origin, tls, JSON.stringify({ protocolVersion: 1, envelope: { ...envelope,
      recipient: 'ah-session:00000000-0000-4000-8000-000000000199' } }))).status).toBe(409)
    const oversized = await post(server.origin, tls, [' '.repeat(1500), ' '.repeat(1500)]).catch(() => ({ status: 0 }))
    expect([0, 400]).toContain(oversized.status)
    const header = await post(server.origin, tls, body, { 'x-oversized': 'x'.repeat(4096) }).catch(() => ({ status: 0 }))
    expect([0, 431]).toContain(header.status)
    senders.add(receiver.address)
    expect((await post(server.origin, tls, JSON.stringify({ protocolVersion: 1, envelope: { ...envelope, sender: receiver.address } }))).status).toBe(403)
    expect(receiver.snapshot().inbox).toHaveLength(0)
    expect((await post(server.origin, tls, body)).status).toBe(200)
    expect(receiver.snapshot().inbox).toHaveLength(1)
  } finally {
    await server.dispose(); await service.dispose(); await local.dispose(); await directory.dispose(); await repository.dispose()
  }
}, 30_000)

it('rejects an expired explicitly trusted server certificate during the real TLS handshake', async () => {
  const [expired, key, ca, client, clientKey] = await Promise.all(['expired-server', 'server-key', 'ca', 'client', 'client-key'].map(cert))
  const directory = createSessionDirectory()
  const server = await createHttpsMessageServer({ directory, host: '127.0.0.1', port: 0,
    tls: { ca: ca!, cert: expired!, key: key! }, peers: [], limits: transportLimits })
  try { await expect(post(server.origin, { ca: expired!, cert: client!, key: clientKey! }, '{}')).rejects.toMatchObject({ code: 'CERT_HAS_EXPIRED' }) }
  finally { await server.dispose(); await directory.dispose() }
})

it('keeps ambiguous HTTP responses pending and never follows a redirect or accepts an unrelated receipt', async () => {
  const [ca, serverCert, serverKey, clientCert, clientKey] = await Promise.all(['ca', 'server', 'server-key', 'client', 'client-key'].map(cert))
  const repository = createRepository()
  const senderHandle = await repository.create()
  const recipientHandle = await repository.create()
  const responses = [
    { status: 200, body: '<html>OK</html>' },
    { status: 202, body: '{}' },
    { status: 404, body: '{}' },
    { status: 302, body: '{}' },
    { status: 200, body: 'x'.repeat(4096) },
    { status: 200, body: JSON.stringify({ protocolVersion: 1, outcome: { kind: 'accepted', receipt: {
      messageId: '10000000-0000-4000-8000-000000000199', recipient: recipientHandle.header.address,
      inboxEventId: `ah-event:${recipientHandle.header.sessionId}:1`,
    } } }) },
  ]
  let requests = 0
  const server = createServer({ ca, cert: serverCert, key: serverKey, requestCert: true, rejectUnauthorized: true }, (incoming, outgoing) => {
    const response = responses[requests++]!
    incoming.resume()
    outgoing.writeHead(response.status, { 'content-type': 'application/json', location: '/must-not-follow' })
    outgoing.end(response.body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const directory = createSessionDirectory()
  const client = createHttpsMessageClientTransport({ directory, origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    serverName: 'localhost', hostKey: 'sender', tls: { ca: ca!, cert: clientCert!, key: clientKey! }, limits: transportLimits })
  const service = new CommunicationService({ directory, transport: client, limits: { ...limits, maxDeliveryAttempts: 10 } })
  const sender = await service.attach(senderHandle, { catalog: messageCatalog,
    policy: { canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }) } })
  try {
    await sender.send(requestMessage, { kind: 'root', recipient: recipientHandle.header.address,
      channelId: parseChannelId('20000000-0000-4000-8000-000000000101') }, { text: 'pending' })
    const dispatcher = service.createDispatcher(sender)
    for (let index = 0; index < responses.length; index++) {
      await dispatcher.dispatch({ maxAttempts: 1 })
      expect(requests).toBe(index + 1)
      expect(sender.snapshot().outbox[0]).toMatchObject({ status: 'pending', attemptCount: index + 1 })
    }
  } finally {
    await client.dispose(); await service.dispose(); await directory.dispose(); await repository.dispose()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}, 30_000)

import { readFile } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CommunicationService,
  createHttpsMessageClientTransport,
  createHttpsMessageServer,
  createInProcessMessageTransport,
  createRoutedMessageTransport,
  createSessionDirectory,
  parseChannelId,
} from '../../src/index.js'
import type { HttpsMessageLimits } from '../../src/index.js'
import { communicationIdentities, createRepository, limits, messageCatalog, requestMessage } from '../communication/fixtures.js'

const certRoot = fileURLToPath(new URL('./certs/', import.meta.url))
const resources: Array<() => Promise<void>> = []
afterEach(async () => {
  const results = await Promise.allSettled(resources.splice(0).reverse().map(dispose => dispose()))
  const failed = results.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
})

const httpsLimits: HttpsMessageLimits = Object.freeze({
  maxHeaderBytes: 8192, maxBodyBytes: 65536, maxResponseBytes: 8192,
  maxConnections: 8, maxInFlightRequests: 8, handshakeTimeoutMs: 5000,
  headersTimeoutMs: 5000, bodyTimeoutMs: 5000, requestTimeoutMs: 5000, idleTimeoutMs: 1000,
})

async function certificates() {
  const ca = await readFile(`${certRoot}ca.pem`)
  const serverCert = await readFile(`${certRoot}server.pem`)
  const serverKey = await readFile(`${certRoot}server-key.pem`)
  const clientCert = await readFile(`${certRoot}client.pem`)
  const clientKey = await readFile(`${certRoot}client-key.pem`)
  return { ca, serverCert, serverKey, clientCert, clientKey,
    clientFingerprint: new X509Certificate(clientCert).fingerprint256 }
}

describe('HTTPS message transport', () => {
  it('persists one delivery through a real mutual-TLS socket', async () => {
    const certs = await certificates()
    const senderRepository = createRepository()
    const recipientRepository = createRepository(undefined, {
      nextSessionId: () => '00000000-0000-4000-8000-000000000104' as never,
    })
    const senderHandle = await senderRepository.create()
    const recipientHandle = await recipientRepository.create()
    const senderDirectory = createSessionDirectory()
    const recipientDirectory = createSessionDirectory()
    const recipientLocal = createInProcessMessageTransport(recipientDirectory)
    const recipientService = new CommunicationService({ directory: recipientDirectory, transport: recipientLocal,
      limits, identitySource: communicationIdentities(['10000000-0000-4000-8000-000000000104']) })
    const recipient = await recipientService.attach(recipientHandle, { catalog: messageCatalog,
      policy: { canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }) } })
    const server = await createHttpsMessageServer({ directory: recipientDirectory, host: '127.0.0.1', port: 0,
      tls: { ca: certs.ca, cert: certs.serverCert, key: certs.serverKey }, limits: httpsLimits,
      peers: [{ hostKey: 'sender-host', fingerprint256: certs.clientFingerprint, senders: new Set([senderHandle.header.address]) }] })
    const client = createHttpsMessageClientTransport({ origin: server.origin, serverName: 'localhost', hostKey: 'sender-host',
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey }, limits: httpsLimits })
    const routed = createRoutedMessageTransport(senderDirectory, address => address === recipient.address
      ? { kind: 'remote', transport: client } : { kind: 'unavailable' })
    const senderService = new CommunicationService({ directory: senderDirectory, transport: routed,
      limits, identitySource: communicationIdentities() })
    const sender = await senderService.attach(senderHandle, { catalog: messageCatalog,
      policy: { canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }) } })
    resources.push(() => senderRepository.dispose(), () => recipientRepository.dispose(), () => senderService.dispose(),
      () => recipientService.dispose(), () => routed.dispose(), () => client.dispose(), () => server.dispose(),
      () => recipientLocal.dispose(), () => senderDirectory.dispose(), () => recipientDirectory.dispose())

    const accepted = await sender.send(requestMessage, { kind: 'root', recipient: recipient.address,
      channelId: parseChannelId('20000000-0000-4000-8000-000000000101') }, { text: 'remote' })
    await expect(senderService.createDispatcher(sender).dispatch()).resolves.toMatchObject({ delivered: 1 })
    expect(recipient.snapshot().inbox).toMatchObject([{ messageId: accepted.messageId, status: 'pending' }])
  })

  it('settles an unauthorized attempt as retryable before surfacing authentication failure', async () => {
    const certs = await certificates()
    const senderRepository = createRepository()
    const recipientRepository = createRepository(undefined, {
      nextSessionId: () => '00000000-0000-4000-8000-000000000104' as never,
    })
    const senderHandle = await senderRepository.create()
    const recipientHandle = await recipientRepository.create()
    const senderDirectory = createSessionDirectory()
    const recipientDirectory = createSessionDirectory()
    const recipientLocal = createInProcessMessageTransport(recipientDirectory)
    const recipientService = new CommunicationService({ directory: recipientDirectory, transport: recipientLocal, limits })
    const recipient = await recipientService.attach(recipientHandle, { catalog: messageCatalog,
      policy: { canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }) } })
    const server = await createHttpsMessageServer({ directory: recipientDirectory, host: '127.0.0.1', port: 0,
      tls: { ca: certs.ca, cert: certs.serverCert, key: certs.serverKey }, limits: httpsLimits,
      peers: [{ hostKey: 'sender-host', fingerprint256: certs.clientFingerprint, senders: new Set([senderHandle.header.address]) }] })
    const client = createHttpsMessageClientTransport({ origin: server.origin, serverName: 'localhost', hostKey: 'wrong-host',
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey }, limits: httpsLimits })
    const routed = createRoutedMessageTransport(senderDirectory, () => ({ kind: 'remote', transport: client }))
    const senderService = new CommunicationService({ directory: senderDirectory, transport: routed,
      limits, identitySource: communicationIdentities() })
    const sender = await senderService.attach(senderHandle, { catalog: messageCatalog,
      policy: { canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }) } })
    resources.push(() => senderRepository.dispose(), () => recipientRepository.dispose(), () => senderService.dispose(),
      () => recipientService.dispose(), () => routed.dispose(), () => client.dispose(), () => server.dispose(),
      () => recipientLocal.dispose(), () => senderDirectory.dispose(), () => recipientDirectory.dispose())

    await sender.send(requestMessage, { kind: 'root', recipient: recipient.address,
      channelId: parseChannelId('20000000-0000-4000-8000-000000000101') }, { text: 'blocked' })
    await expect(senderService.createDispatcher(sender).dispatch()).rejects.toMatchObject({ code: 'MESSAGE_TRANSPORT_SOURCE_INVALID' })
    expect(sender.snapshot().outbox[0]).toMatchObject({ status: 'pending', attemptCount: 1, lastFailure: { code: 'transport-outcome-unknown' } })
    expect(recipient.snapshot().inbox).toHaveLength(0)
  })
})

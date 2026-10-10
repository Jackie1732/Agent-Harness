import { readFile } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  CommunicationService,
  MemorySessionBackend,
  createSessionDirectory,
  createInProcessMessageTransport,
  createHttpsMessageClientTransport,
  createHttpsMessageServer,
  parseChannelId,
} from '../../src/index.js'
import type { SessionBackend } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'
import {
  createRepository,
  limits,
  messageCatalog,
  requestMessage,
  sessionIdentities,
  sessionIds,
} from '../communication/fixtures.js'

it('treats a real HTTPS request deadline as unknown and retries the stable Inbox receipt', async () => {
  const certificate = (name: string) => readFile(new URL(`./certs/${name}.pem`, import.meta.url))
  const [ca, serverCert, serverKey, clientCert, clientKey] = await Promise.all([
    certificate('ca'), certificate('server'), certificate('server-key'),
    certificate('client'), certificate('client-key'),
  ])
  const inner = new MemorySessionBackend({ maxRecordBytes: 8192 })
  const entered = createDeferred<void>()
  const release = createDeferred<void>()
  let pending = true
  const backend: SessionBackend = {
    get maxRecordBytes() { return inner.maxRecordBytes },
    create: header => inner.create(header),
    readPrefix: (sessionId, through) => inner.readPrefix(sessionId, through),
    async openWriter(sessionId, validateCommitted) {
      const writer = await inner.openWriter(sessionId, validateCommitted)
      return {
        header: writer.header,
        readCommitted: () => writer.readCommitted(),
        async append(position, event) {
          if (pending && event.type === 'communication/inbox-accepted') {
            pending = false
            entered.resolve()
            await release.promise
          }
          return writer.append(position, event)
        },
        dispose: () => writer.dispose(),
      }
    },
    dispose: () => inner.dispose(),
  }
  const recipientRepository = createRepository(backend, sessionIdentities([sessionIds[3]]))
  const senderRepository = createRepository()
  const senderHandle = await senderRepository.create()
  const senderDirectory = createSessionDirectory()
  const recipientDirectory = createSessionDirectory()
  const local = createInProcessMessageTransport(recipientDirectory)
  const recipientService = new CommunicationService({ directory: recipientDirectory, transport: local, limits })
  const policy = { canSend: () => ({ kind: 'allow' as const }), canReceive: () => ({ kind: 'allow' as const }) }
  const recipient = await recipientService.attach(await recipientRepository.create(), { catalog: messageCatalog, policy })
  const transportLimits = {
    maxHeaderBytes: 8192, maxBodyBytes: 65536, maxResponseBytes: 8192,
    maxConnections: 8, maxInFlightRequests: 8, handshakeTimeoutMs: 5000, headersTimeoutMs: 5000,
    bodyTimeoutMs: 5000, requestTimeoutMs: 500, idleTimeoutMs: 100,
  }
  const accepted = createDeferred<void>()
  const server = await createHttpsMessageServer({
    directory: recipientDirectory, host: '127.0.0.1', port: 0,
    tls: { ca, cert: serverCert, key: serverKey }, limits: transportLimits,
    peers: [{ hostKey: 'sender', fingerprint256: new X509Certificate(clientCert).fingerprint256,
      senders: new Set([senderHandle.header.address]) }],
    onAccepted: () => accepted.resolve(),
  })
  const client = createHttpsMessageClientTransport({
    directory: senderDirectory, origin: server.origin, serverName: 'localhost', hostKey: 'sender',
    tls: { ca, cert: clientCert, key: clientKey }, limits: transportLimits,
  })
  const senderService = new CommunicationService({ directory: senderDirectory, transport: client, limits })
  const sender = await senderService.attach(senderHandle, { catalog: messageCatalog, policy })
  try {
    const outgoing = await sender.send(requestMessage, {
      kind: 'root', recipient: recipient.address,
      channelId: parseChannelId('20000000-0000-4000-8000-000000000101'),
    }, { text: 'deadline' })
    const dispatcher = senderService.createDispatcher(sender)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const run = dispatcher.dispatch({ maxAttempts: 1 })
    await entered.promise
    await vi.advanceTimersByTimeAsync(transportLimits.requestTimeoutMs)
    expect(await run).toMatchObject({ startedAttempts: 1, retryable: 1 })
    vi.useRealTimers()
    expect(sender.snapshot().outbox[0]).toMatchObject({
      status: 'pending', attemptCount: 1, lastFailure: { code: 'transport-outcome-unknown' },
    })
    expect(recipient.snapshot().inbox).toHaveLength(0)
    release.resolve()
    await accepted.promise
    const inboxEventId = recipient.snapshot().inbox[0]!.acceptedEventId
    expect(await dispatcher.dispatch({ maxAttempts: 1 })).toMatchObject({ startedAttempts: 1, delivered: 1 })
    expect(recipient.snapshot().inbox).toHaveLength(1)
    expect(sender.snapshot().outbox[0]).toMatchObject({
      status: 'delivered', attemptCount: 2, receipt: { messageId: outgoing.messageId, inboxEventId },
    })
  } finally {
    vi.useRealTimers()
    release.resolve()
    await client.dispose()
    await senderService.dispose()
    await recipientService.dispose()
    await server.dispose()
    await local.dispose()
    await senderDirectory.dispose()
    await recipientDirectory.dispose()
    await senderRepository.dispose()
    await recipientRepository.dispose()
  }
}, 15_000)

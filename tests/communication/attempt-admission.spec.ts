import { expect, it } from 'vitest'
import {
  CommunicationService,
  MemorySessionBackend,
  createSessionDirectory,
  parseChannelId,
} from '../../src/index.js'
import type { MessageTransport, SessionBackend } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'
import {
  communicationIdentities,
  createRepository,
  limits,
  messageCatalog,
  requestMessage,
} from './fixtures.js'

it('settles an admitted attempt when cancellation arrives while attempt-started commits', async () => {
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
          if (pending && event.type === 'communication/outbox-attempt-started') {
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
  const repository = createRepository(backend)
  const directory = createSessionDirectory()
  let calls = 0
  const transport: MessageTransport = {
    async deliver(_envelope, options) {
      calls += 1
      expect(options.signal.aborted).toBe(true)
      return { kind: 'retry', code: 'attempt-interrupted' }
    },
    async dispose() {},
  }
  const service = new CommunicationService({ directory, transport, limits, identitySource: communicationIdentities() })
  const policy = { canSend: () => ({ kind: 'allow' as const }), canReceive: () => ({ kind: 'allow' as const }) }
  try {
    const sender = await service.attach(await repository.create(), { catalog: messageCatalog, policy })
    const recipient = await repository.create()
    await sender.send(requestMessage, {
      kind: 'root', recipient: recipient.header.address,
      channelId: parseChannelId('20000000-0000-4000-8000-000000000101'),
    }, { text: 'admitted' })
    const controller = new AbortController()
    const run = service.createDispatcher(sender).dispatch({ signal: controller.signal })
    await entered.promise
    controller.abort()
    release.resolve()
    expect(await run).toMatchObject({ startedAttempts: 1, retryable: 1, stoppedBy: 'aborted' })
    expect(calls).toBe(1)
    expect(sender.snapshot().outbox[0]).toMatchObject({
      status: 'pending', attemptCount: 1,
      lastFailure: { attempt: 1, code: 'attempt-interrupted' },
    })
    expect(sender.snapshot().outbox[0]).not.toHaveProperty('openAttempt')
  } finally {
    release.resolve()
    await service.dispose()
    await directory.dispose()
    await repository.dispose()
  }
})

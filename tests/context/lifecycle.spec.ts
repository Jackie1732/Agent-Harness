import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  MemorySessionBackend,
  SessionContext,
  SessionContextKey,
  createCapabilityKey,
  createSessionContextComponent,
} from '../../src/index.js'
import type { SessionBackend, SessionHandle, SessionLogPosition, SessionWriter, StoredSessionEvent } from '../../src/index.js'
import { contextInputRecordedEvent } from '../../src/context/session-events.js'
import { createDeferred } from '../helpers/deferred.js'
import { emptyMessageCatalog, repository } from './fixtures.js'

const input = (text: string) => ({ kind: 'user' as const, origin: 'host-authored' as const, originLabel: 'test', text })

function blockedAppendBackend(inner: SessionBackend, entered: () => void, release: Promise<void>): SessionBackend {
  return {
    get maxRecordBytes() { return inner.maxRecordBytes },
    create: header => inner.create(header),
    readPrefix: (sessionId, through) => inner.readPrefix(sessionId, through),
    async openWriter(sessionId): Promise<SessionWriter> {
      const writer = await inner.openWriter(sessionId)
      return {
        header: writer.header,
        readCommitted: () => writer.readCommitted(),
        async append(position: SessionLogPosition, event: StoredSessionEvent) {
          if (event.type === contextInputRecordedEvent.type) {
            entered()
            await release
          }
          return await writer.append(position, event)
        },
        dispose: () => writer.dispose(),
      }
    },
    dispose: () => inner.dispose(),
  }
}

describe('SessionContext lifecycle', () => {
  it('rejects overlapping work and dispose joins the accepted commit without releasing the Handle', async () => {
    const gate = createDeferred<void>()
    const entered = createDeferred<void>()
    const backend = blockedAppendBackend(
      new MemorySessionBackend({ maxRecordBytes: 2 * 1024 * 1024 }),
      () => entered.resolve(),
      gate.promise,
    )
    const repo = repository(backend)
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const accepted = context.recordInput(input('accepted'))
      await entered.promise
      expect(() => context.recordInput(input('overlap'))).toThrowError(
        expect.objectContaining({ code: 'CONTEXT_SESSION_BUSY' }),
      )
      const disposal = context.dispose()
      expect(context.status).toBe('disposing')
      gate.resolve()
      await expect(accepted).resolves.toMatchObject({ payload: { text: 'accepted' } })
      await disposal
      expect(context.status).toBe('disposed')
      expect(handle.status).toBe('open')
      expect(handle.snapshot().localPosition).toBe(1)
    } finally {
      await repo.dispose()
    }
  })

  it('a Component releases Context before the borrowed Session capability', async () => {
    const registry = new CapabilityRegistry()
    const SessionKey = createCapabilityKey<SessionHandle>('test.context.handle')
    let handle: SessionHandle | undefined
    let context: SessionContext | undefined
    registry.mount({
      label: 'Session owner',
      requires: [],
      provides: [SessionKey],
      setup: async component => {
        const repo = await component.apply(
          'repository',
          () => repository(),
          active => active.dispose(),
        )
        handle = await component.apply('Session Handle', () => repo.create(), active => active.dispose())
        component.provide(SessionKey, handle)
      },
    })
    const contextComponent = registry.mount(createSessionContextComponent({
      label: 'Session Context',
      sessionKey: SessionKey,
      messageCatalog: emptyMessageCatalog,
    }))
    registry.mount({
      label: 'Context binding consumer',
      requires: [SessionContextKey],
      provides: [],
      setup: component => { context = component.require(SessionContextKey) },
    })
    await registry.whenQuiescent()
    expect(context?.status).toBe('accepting')
    await contextComponent.dispose()
    await registry.whenQuiescent()
    expect(context?.status).toBe('disposed')
    expect(handle?.status).toBe('open')
    await registry.dispose()
    expect(handle?.status).toBe('disposed')
    void context
  })

  it('an aborted owning signal closes admission without disposing the Session', async () => {
    const repo = repository()
    try {
      const handle = await repo.create()
      const controller = new AbortController()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog, signal: controller.signal })
      controller.abort()
      expect(context.status).toBe('disposing')
      expect(() => context.recordInput(input('too late'))).toThrowError(expect.objectContaining({ code: 'CONTEXT_INACTIVE' }))
      expect(handle.status).toBe('open')
      await context.dispose()
    } finally {
      await repo.dispose()
    }
  })
})

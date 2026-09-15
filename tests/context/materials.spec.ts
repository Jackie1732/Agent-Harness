import { describe, expect, it } from 'vitest'
import {
  MemorySessionBackend,
  SessionContext,
  SessionRepository,
  createDurableEventCatalog,
  createDurableEventDefinition,
  parseSessionId,
  projectContextSession,
} from '../../src/index.js'
import type { SessionBackend, SessionLogPosition, SessionWriter, StoredSessionEvent } from '../../src/index.js'
import { contextInputRecordedEvent } from '../../src/context/session-events.js'
import { emptyMessageCatalog, identities, profile, repository } from './fixtures.js'

const userInput = (text: string) => ({ kind: 'user' as const, origin: 'host-authored' as const, originLabel: 'test', text })

function loseAcknowledgement(inner: SessionBackend): SessionBackend {
  let lose = true
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
          const committed = await writer.append(position, event)
          if (lose && event.type === contextInputRecordedEvent.type) {
            lose = false
            throw new Error('acknowledgement lost')
          }
          return committed
        },
        dispose: () => writer.dispose(),
      }
    },
    dispose: () => inner.dispose(),
  }
}

describe('Context material commits', () => {
  it('records exact Profile, Input, Memory, and retraction revisions', async () => {
    const repo = repository()
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const source = { ...profile(), sections: [{ name: 'rules', slot: 'rules' as const, ordinal: 0, text: 'Answer precisely.', originLabel: 'test' }] }
      const profileCommit = context.recordProfile(source)
      source.sections[0]!.text = 'mutated after admission'
      const committedProfile = await profileCommit
      expect(committedProfile.payload.sections[0]!.text).toBe('Answer precisely.')
      const input = await context.recordInput(userInput('literal ${HOME} {{value}}'))
      const memory = await context.recordMemory({
        key: 'fact', previousEventId: null, text: 'literal ${HOME} {{value}}', tags: ['research'],
        origin: { kind: 'verbatim', source: { eventId: input.stored.eventId, selector: 'input-text' } },
      })
      await context.retractMemory({ key: 'fact', previousEventId: memory.stored.eventId, reasonCode: 'incorrect' })

      const snapshot = projectContextSession(handle.snapshot())
      expect(snapshot.profileHeads).toEqual([{ profileKey: 'generation', eventId: committedProfile.stored.eventId }])
      expect(snapshot.inputs.map(item => item.payload)).toEqual([userInput('literal ${HOME} {{value}}')])
      expect(snapshot.memory).toMatchObject([{ key: 'fact', record: null }])
      expect(handle.status).toBe('open')
      await context.dispose()
      expect(handle.status).toBe('open')
    } finally {
      await repo.dispose()
    }
  })

  it('linearizes two Context objects by the Session CAS rather than shared memory', async () => {
    const repo = repository()
    try {
      const handle = await repo.create()
      const first = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const second = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const outcomes = await Promise.allSettled([
        first.recordProfile(profile('generation', { sections: [] })),
        second.recordProfile(profile('generation', { sections: [] })),
      ])
      expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(item => item.status === 'rejected')[0]).toMatchObject({
        reason: { code: 'CONTEXT_REVISION_CONFLICT' },
      })
      expect(handle.snapshot().localPosition).toBe(1)
      expect(first.status).toBe('accepting')
      expect(second.status).toBe('accepting')
    } finally {
      await repo.dispose()
    }
  })

  it('cancels before append acceptance and faults only on an unknown commit', async () => {
    const backend = loseAcknowledgement(new MemorySessionBackend({ maxRecordBytes: 2 * 1024 * 1024 }))
    const repo = repository(backend)
    const handle = await repo.create()
    const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
    const abort = new AbortController()
    abort.abort()
    expect(() => context.recordInput(userInput('cancelled'), { signal: abort.signal })).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_INACTIVE' }),
    )
    expect(handle.snapshot().localPosition).toBe(0)

    await expect(context.recordInput(userInput('committed but acknowledgement lost'))).rejects.toMatchObject({
      code: 'CONTEXT_JOURNAL_COMMIT_UNKNOWN',
      details: {
        eventType: contextInputRecordedEvent.type,
        expectedLocalPosition: 0,
        payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(context.status).toBe('faulted')
    await expect(context.dispose()).rejects.toMatchObject({ code: 'CONTEXT_JOURNAL_COMMIT_UNKNOWN' })
    await handle.dispose()
    const reopened = await repo.open(handle.header.sessionId)
    expect(projectContextSession(reopened.snapshot()).inputs[0]!.payload).toEqual(userInput('committed but acknowledgement lost'))
    await repo.dispose()
  })

  it('ignores an unknown Context extension only when its envelope is explicitly ignorable', async () => {
    const extension = createDurableEventDefinition({
      type: 'context/example-extension', payloadVersion: 1, ignorable: true,
      decode: value => value,
    })
    const repo = new SessionRepository({
      backend: new MemorySessionBackend({ maxRecordBytes: 8192 }),
      catalog: createDurableEventCatalog([extension]),
      maxLineageDepth: 1,
      identitySource: identities(['30000000-0000-4000-8000-000000000199']),
    })
    try {
      const handle = await repo.create()
      await handle.append(extension, { retained: true })
      const original = handle.snapshot()
      const local = original.history[0]!
      const opaque = { kind: 'opaque' as const, stored: local.events[0]!.stored }
      const snapshot = {
        ...original,
        history: [{ ...local, events: [opaque] }],
      }
      expect(projectContextSession(snapshot).inputs).toEqual([])
    } finally {
      await repo.dispose()
    }
  })

  it('rejects a Session Catalog that cannot persist the six Context event identities', async () => {
    const repo = new SessionRepository({
      backend: new MemorySessionBackend({ maxRecordBytes: 8192 }),
      catalog: createDurableEventCatalog(),
      maxLineageDepth: 1,
      identitySource: { nextSessionId: () => parseSessionId('30000000-0000-4000-8000-000000000198') },
    })
    try {
      const handle = await repo.create()
      expect(() => new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })).toThrowError(
        expect.objectContaining({ code: 'CONTEXT_STATE_INVALID' }),
      )
    } finally {
      await repo.dispose()
    }
  })
})

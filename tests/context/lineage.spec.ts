import { describe, expect, it } from 'vitest'
import { SessionContext, rebuildAssembly } from '../../src/index.js'
import { emptyMessageCatalog, profile, repository, scriptedModel, selection } from './fixtures.js'

describe('Context lineage history', () => {
  it('uses only explicitly ordered ancestor cuts and remains stable after the parent advances', async () => {
    const repo = repository()
    const provider = scriptedModel()
    try {
      const parent = await repo.create()
      const parentContext = new SessionContext({ session: parent, messageCatalog: emptyMessageCatalog })
      await parentContext.recordInput({
        kind: 'user', origin: 'host-authored', originLabel: 'parent', text: 'captured ancestor input',
      })
      const child = await repo.fork(parent.header.sessionId)
      const childContext = new SessionContext({ session: child, messageCatalog: emptyMessageCatalog })
      const childProfile = await childContext.recordProfile(profile('generation', { historyScope: 'allow-lineage' }))
      const assembled = await childContext.assemble(selection(childProfile.stored.eventId, provider.descriptor, {
        history: {
          mode: 'lineage-suffix', representation: 'raw', ancestorSessionIds: [parent.header.sessionId],
        },
      }))
      expect(assembled.kind).toBe('ready')
      if (assembled.kind !== 'ready') throw new Error('expected lineage assembly')
      expect(assembled.request.messages).toEqual([
        { role: 'user', content: [{ kind: 'text', text: 'captured ancestor input' }] },
      ])
      expect(assembled.committed.payload.coverage).toEqual([
        { sessionId: parent.header.sessionId, through: 1 },
        { sessionId: child.header.sessionId, through: 1 },
      ])

      await parentContext.recordInput({
        kind: 'user', origin: 'host-authored', originLabel: 'parent', text: 'not inherited after fork',
      })
      expect(rebuildAssembly(child.snapshot(), assembled.committed.stored.eventId)).toMatchObject({
        kind: 'rebuilt', request: assembled.request,
      })
      expect(child.snapshot().history[0]!.through).toBe(1)

      await childContext.dispose()
      await parentContext.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('rejects lineage selection when the pinned Profile permits only local history', async () => {
    const repo = repository()
    const provider = scriptedModel()
    try {
      const parent = await repo.create()
      const parentContext = new SessionContext({ session: parent, messageCatalog: emptyMessageCatalog })
      await parentContext.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'parent', text: 'ancestor' })
      const child = await repo.fork(parent.header.sessionId)
      const childContext = new SessionContext({ session: child, messageCatalog: emptyMessageCatalog })
      const childProfile = await childContext.recordProfile(profile())
      await expect(childContext.assemble(selection(childProfile.stored.eventId, provider.descriptor, {
        history: {
          mode: 'lineage-suffix', representation: 'raw', ancestorSessionIds: [parent.header.sessionId],
        },
      }))).rejects.toMatchObject({ code: 'CONTEXT_SOURCE_INVALID' })
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })
})

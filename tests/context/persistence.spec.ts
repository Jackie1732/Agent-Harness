import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileSessionBackend,
  SessionContext,
  projectContextSession,
  rebuildAssembly,
} from '../../src/index.js'
import { createFileSessionBackendForTest } from '../../src/session/file-backend.js'
import { writeAll } from '../../src/session/file-store.js'
import { emptyMessageCatalog, profile, repository, scriptedModel, selection } from './fixtures.js'

describe('Context file recovery', () => {
  it('faults on a lost File sync acknowledgement and recovers only from a fresh object graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-context-file-unknown-'))
    const options = { root, maxRecordBytes: 2 * 1024 * 1024 }
    let writes = 0
    let first = repository(createFileSessionBackendForTest(options, {
      writeAll: async (...arguments_) => {
        writes += 1
        await writeAll(...arguments_)
      },
      sync: async handle => {
        await handle.sync()
        if (writes === 2) throw new Error('injected lost sync acknowledgement')
      },
    }))
    try {
      const handle = await first.create()
      const sessionId = handle.header.sessionId
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      await context.recordProfile(profile())
      await expect(context.recordInput({
        kind: 'user', origin: 'host-authored', originLabel: 'file fixture', text: 'commit survived unknown acknowledgement',
      })).rejects.toMatchObject({ code: 'CONTEXT_JOURNAL_COMMIT_UNKNOWN' })
      expect(context.status).toBe('faulted')
      await expect(context.dispose()).rejects.toMatchObject({ code: 'CONTEXT_JOURNAL_COMMIT_UNKNOWN' })
      await handle.dispose()
      await first.dispose()

      first = repository(new FileSessionBackend(options))
      const reopened = await first.open(sessionId)
      expect(projectContextSession(reopened.snapshot()).inputs).toMatchObject([
        { payload: { text: 'commit survived unknown acknowledgement' } },
      ])
    } finally {
      await first.dispose().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reopens committed facts and rebuilds an old Assembly without runtime providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-context-file-'))
    const provider = scriptedModel()
    let first = repository(new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }))
    try {
      const handle = await first.create()
      const sessionId = handle.header.sessionId
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile())
      const recordedInput = await context.recordInput({
        kind: 'user', origin: 'host-import', originLabel: 'file fixture', text: 'persisted context',
      })
      const assembled = await context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
      }))
      if (assembled.kind !== 'ready') throw new Error('expected ready assembly')
      const assemblyEventId = assembled.committed.stored.eventId
      const request = assembled.request
      await context.dispose()
      await handle.dispose()
      await first.dispose()

      first = repository(new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }))
      const reopened = await first.open(sessionId)
      const rebuilt = rebuildAssembly(reopened.snapshot(), assemblyEventId)
      expect(rebuilt).toMatchObject({ kind: 'rebuilt', request })
      const recovered = new SessionContext({ session: reopened, messageCatalog: emptyMessageCatalog })
      expect(recovered.snapshot()).toMatchObject({
        profiles: [{ stored: { eventId: recordedProfile.stored.eventId } }],
        inputs: [{ stored: { eventId: recordedInput.stored.eventId } }],
        assemblies: [{ committed: { stored: { eventId: assemblyEventId } } }],
      })
      await recovered.dispose()
    } finally {
      await provider.dispose()
      await first.dispose().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { contextProfile, contextSelection, scriptedTextProvider, sessionRepository } from './context-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'atomic-context-example-'))
const provider = scriptedTextProvider()
let repository = sessionRepository(new h.FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }))
try {
  const session = await repository.create()
  const sessionId = session.header.sessionId
  const context = new h.SessionContext({ session, messageCatalog: h.createMessageCatalog() })
  const profile = await context.recordProfile(contextProfile())
  const input = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'example', text: 'offline material' })
  await context.recordMemory({
    key: 'topic', previousEventId: null, text: 'offline material', tags: ['example'],
    origin: { kind: 'verbatim', source: { eventId: input.stored.eventId, selector: 'input-text' } },
  })
  const assembled = await context.assemble(contextSelection(profile.stored.eventId, provider.descriptor, {
    requiredInputs: [{ eventId: input.stored.eventId, selector: 'user-input' }],
    memory: { required: [], query: { requiredTags: ['example'], queryTags: ['example'], topK: 1 } },
  }))
  assert.equal(assembled.kind, 'ready')
  const assemblyEventId = assembled.committed.stored.eventId
  const expected = assembled.request
  await context.dispose()
  await session.dispose()
  await repository.dispose()

  repository = sessionRepository(new h.FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }))
  const reopened = await repository.open(sessionId)
  const rebuilt = h.rebuildAssembly(reopened.snapshot(), assemblyEventId)
  assert.equal(rebuilt.kind, 'rebuilt')
  assert.deepEqual(rebuilt.request, expected)
  process.stdout.write(`${JSON.stringify({ example: 'offline-replay', assemblyEventId, requestDigest: rebuilt.assembly.requestDigest })}\n`)
} finally {
  await provider.dispose()
  await repository.dispose().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}

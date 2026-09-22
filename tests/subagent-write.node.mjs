import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { h, fixture, FaultBackend, schemaLimits, toolLimits } from './helpers/tool-fixture.mjs'
import { WorkspaceAuthority } from '../dist/subagent/workspace.js'

for (const point of ['before-start', 'start-ack', 'result-ack']) test(`write_text ${point} preserves the real file and never replays an uncertain execution`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'write-cp-'))
  const storage = join(root, 'sessions'); const workspace = join(root, 'work')
  await mkdir(join(workspace, 'out'), { recursive: true })
  const clock = { now: () => Date.parse('2026-09-22T00:00:00Z') }
  const authority = await WorkspaceAuthority.create([{ resourceId: 'work', rootPath: workspace, mode: 'exclusive-write', protectedRoots: [],
    readPrefixes: [], writePrefixes: ['out'], maxBaselineFiles: 0, maxBaselineBytes: 0 }], [], [], clock)
  const lease = authority.reserve({ kind: 'exclusive-write', resourceId: 'work', readFiles: [], writePrefixes: ['out'] }, 0, 0)
  let sessionId
  try {
    const provider = await h.createWorkspaceWriteTextProvider({ rootId: 'work', rootPath: workspace, protectedRoots: [], maxWriteBytes: 1024,
      maxPathBytes: 1024, maxArgumentsBytes: toolLimits.maxArgumentsBytes, maxResultBytes: toolLimits.maxResultBytes, schemaLimits, access: lease })
    let injected = false
    const inject = async event => {
      if (!injected && event.type === (point === 'result-ack' ? 'tool/invocation-settled' : 'tool/invocation-started')) {
        injected = true; throw new h.SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'injected acknowledgement loss')
      }
    }
    const backend = new FaultBackend(new h.FileSessionBackend({ root: storage, maxRecordBytes: 262144 }),
      point === 'before-start' ? inject : undefined, point === 'before-start' ? undefined : inject)
    await fixture(async f => {
      sessionId = f.session.header.sessionId
      await assert.rejects(f.runner.invoke({ name: 'write_text', input: { path: 'out/result.txt', text: 'published once' } }), { code: 'TOOL_JOURNAL_COMMIT_UNKNOWN' })
      assert.equal(injected, true)
      if (point === 'result-ack') assert.equal(await readFile(join(workspace, 'out/result.txt'), 'utf8'), 'published once')
      else await assert.rejects(readFile(join(workspace, 'out/result.txt')), { code: 'ENOENT' })
    }, { backend, provider, definition: h.createWriteTextDefinition(schemaLimits), allowCleanupFailure: true })
    await lease.dispose()
    const repository = new h.SessionRepository({ backend: new h.FileSessionBackend({ root: storage, maxRecordBytes: 262144 }),
      catalog: h.createDurableEventCatalog(h.toolSessionEventDefinitions), maxLineageDepth: 4, clock })
    try {
      const session = await repository.open(sessionId)
      await h.recoverToolSession(session, { predecessorStopped: true, maxJournalConflicts: 4 })
      assert.equal(h.projectToolSession(session.snapshot()).pendingInvocationId, null)
      if (point === 'result-ack') assert.equal(await readFile(join(workspace, 'out/result.txt'), 'utf8'), 'published once')
      else await assert.rejects(readFile(join(workspace, 'out/result.txt')), { code: 'ENOENT' })
    } finally { await repository.dispose() }
  } finally { await authority.dispose(); await rm(root, { recursive: true, force: true }) }
})

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileSessionBackendForTest, FileSessionBackend } from '../../src/session/file-backend.js'
import { writeAll } from '../../src/session/file-store.js'
import { createDurableEventCatalog, createDurableEventDefinition } from '../../src/session/event-catalog.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { SessionError } from '../../src/session/errors.js'
import { sessionLogPosition } from '../../src/session/ids.js'
import type { SessionBackend } from '../../src/session/backend.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { modelPreparedEvent, modelStartedEvent, modelSettledEvent } from '../../src/model/session-events.js'
import { parseModelInvocationId } from '../../src/model/ids.js'
import { projectModelSession } from '../../src/model/projection.js'
import { recoverModelInvocation } from '../../src/model/recovery.js'
import { emptyModelResult } from '../../src/model/budget.js'
import { deferred, hasCode, repository, request, runnerLimits, scripted, textFrames } from './fixtures.js'
import type { RegisterCase } from './fixtures.js'

export function persistenceCases(test: RegisterCase): void {
  test('S6-01: incompatible Catalog rejects construction before Provider code', async () => {
    const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 65536 }), catalog: createDurableEventCatalog(), maxLineageDepth: 0 })
    let prepares = 0; const provider = scripted({ onPrepare: () => { prepares++ } }); const session = await repo.create()
    try { assert.throws(() => new SessionModelRunner({ session, provider, limits: runnerLimits }), hasCode('MODEL_SESSION_CATALOG_INCOMPATIBLE')); assert.equal(prepares, 0); assert.equal(session.snapshot().localPosition, 0) }
    finally { await provider.dispose(); await repo.dispose() }
  })
  test('S6-04/06: conditional comparison is queued and healthy; Backend conflict still faults', async () => {
    const event = createDurableEventDefinition({ type: 'test/cas', payloadVersion: 1, ignorable: false, decode: value => value })
    const inner = new MemorySessionBackend({ maxRecordBytes: 65536 })
    let backendConflict = false
    const backend: SessionBackend = {
      get maxRecordBytes() { return inner.maxRecordBytes }, create: header => inner.create(header),
      openWriter: async id => { const writer = await inner.openWriter(id); return { ...writer, append: async (position, value) => { if (backendConflict) throw new SessionError('SESSION_POSITION_CONFLICT', 'injected stale backend'); return writer.append(position, value) } } },
      readPrefix: (id, through) => inner.readPrefix(id, through), dispose: () => inner.dispose(),
    }
    const repo = new SessionRepository({ backend, catalog: createDurableEventCatalog([event]), maxLineageDepth: 0 }); const handle = await repo.create()
    try {
      const input = { value: 'before' }; const a = handle.appendIfPosition(sessionLogPosition(0), event, input); input.value = 'after'
      const b = handle.appendIfPosition(sessionLogPosition(0), event, {}); void b.catch(() => undefined)
      assert.deepEqual((await a).payload, { value: 'before' }); await assert.rejects(b, hasCode('SESSION_PRECONDITION_FAILED')); assert.equal(handle.status, 'open')
      await handle.append(event, {}); backendConflict = true
      await assert.rejects(handle.append(event, {}), hasCode('SESSION_POSITION_CONFLICT')); assert.equal(handle.status, 'faulted')
    } finally { await repo.dispose() }
  })
  for (const checkpoint of [1, 2]) {
    test(`S6-${checkpoint === 1 ? '11' : '13'}: CP${checkpoint - 1} sync barrier prevents external start`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'model-cp-barrier-')); const entered = deferred(); const release = deferred(); let writes = 0; let starts = 0
      const backend = createFileSessionBackendForTest({ root, maxRecordBytes: 65536 }, { writeAll: async (...args) => { writes++; await writeAll(...args) }, sync: async handle => { if (writes === checkpoint) { entered.resolve(); await release.promise } await handle.sync() } })
      const repo = repository(backend); const provider = scripted({ script: async function* () { starts++; yield* textFrames() } }); const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits }); const pending = runner.invoke(request())
      try { await entered.promise; assert.equal(starts, 0); assert.equal(session.snapshot().localPosition, checkpoint - 1); release.resolve(); assert.equal((await pending).payload.outcome, 'completed'); assert.equal(starts, 1) }
      finally { release.resolve(); await pending; await runner.dispose(); await provider.dispose(); await repo.dispose(); await rm(root, { recursive: true, force: true }) }
    })
  }
  for (const checkpoint of [1, 2, 3]) {
    for (const persisted of [false, true]) {
      const evidence = checkpoint === 1 ? (persisted ? '12/37' : '12') : checkpoint === 2 ? (persisted ? '14/38' : '14/37') : (persisted ? '35/36' : '35/38')
      test(`S6-${evidence}: CP${checkpoint - 1} unknown, persisted=${persisted}, new File object graph`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'model-cp-unknown-')); let writes = 0; let starts = 0
        const backend = createFileSessionBackendForTest({ root, maxRecordBytes: 65536 }, {
          writeAll: async (...args) => { writes++; if (writes === checkpoint && !persisted) throw new Error('injected before write'); await writeAll(...args) },
          sync: async handle => { await handle.sync(); if (writes === checkpoint && persisted) throw new Error('injected lost confirmation') },
        })
        const repo = repository(backend); const provider = scripted({ script: async function* () { starts++; yield* textFrames() } }); const session = await repo.create(); const id = session.header.sessionId
        const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
        try {
          await assert.rejects(runner.invoke(request()), hasCode('MODEL_JOURNAL_COMMIT_UNKNOWN')); assert.equal(runner.status, 'faulted'); assert.equal(starts, checkpoint === 3 ? 1 : 0)
          await runner.dispose().catch(() => undefined); await provider.dispose(); await repo.dispose()
          const reopened = repository(new FileSessionBackend({ root, maxRecordBytes: 65536 }))
          try {
            const handle = await reopened.open(id); const before = projectModelSession(handle.snapshot()); const entry = before.invocations[0]
            assert.equal(handle.snapshot().localPosition, persisted ? checkpoint : checkpoint - 1)
            if (entry !== undefined) {
              const settled = await recoverModelInvocation(handle, { invocationId: entry.invocationId, predecessorStopped: true, maxJournalConflicts: 4 })
              if (checkpoint === 3 && persisted) assert.equal(settled.payload.outcome, 'completed')
              else { assert.equal(settled.payload.outcome, 'interrupted'); assert.equal(settled.payload.external, entry.state === 'started' ? 'may-have-been-issued' : 'not-issued'); assert.equal(settled.payload.result.usage.completeness, 'unknown') }
              const again = await recoverModelInvocation(handle, { invocationId: entry.invocationId, predecessorStopped: true, maxJournalConflicts: 4 }); assert.equal(again.stored.eventId, settled.stored.eventId)
            }
            assert.equal(starts, checkpoint === 3 ? 1 : 0)
          } finally { await reopened.dispose() }
        } finally { await runner.dispose().catch(() => undefined); await provider.dispose(); await repo.dispose(); await rm(root, { recursive: true, force: true }) }
      })
    }
  }
  test('S6-36/39: settled File history reopens without Provider or network objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-readonly-')); const repo = repository(new FileSessionBackend({ root, maxRecordBytes: 65536 })); const provider = scripted(); const session = await repo.create(); const id = session.header.sessionId; const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      const committed = await runner.invoke(request()); const before = runner.snapshot(); await runner.dispose(); await provider.dispose(); await repo.dispose()
      const reopened = repository(new FileSessionBackend({ root, maxRecordBytes: 65536 }))
      try { const after = projectModelSession(await reopened.read(id)); assert.deepEqual(after, before); assert.equal(after.invocations[0]?.state, 'settled'); assert.equal(after.invocations[0]?.prepared.payload.submission.request.model, 'fixture-model'); const entry = after.invocations[0]; assert.ok(entry?.state === 'settled'); assert.equal(entry.settled.stored.eventId, committed.stored.eventId) }
      finally { await reopened.dispose() }
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose(); await rm(root, { recursive: true, force: true }) }
  })
  test('S6-40/41/52: Fork does not adopt pending work, later Parent changes do not alter child prefix', async () => {
    const repo = repository(); const provider = scripted(); const parent = await repo.create(); const invocationId = parseModelInvocationId('11111111-1111-4111-8111-111111111111')
    const prepared = await parent.append(modelPreparedEvent, { invocationId, submission: provider.prepare(request()).submission, limits: runnerLimits })
    const child = await repo.fork(parent.header.sessionId); const cut = child.snapshot().history[0]?.through
    const runner = new SessionModelRunner({ session: child, provider, limits: runnerLimits })
    try {
      assert.equal(runner.snapshot().pendingInvocationId, null); assert.equal(runner.snapshot().invocations.length, 0)
      await runner.invoke(request())
      await parent.append(modelStartedEvent, { invocationId, preparedEventId: prepared.stored.eventId, fingerprint: prepared.payload.submission.fingerprint })
      assert.equal(child.snapshot().history[0]?.through, cut)
      await parent.end(); assert.throws(() => projectModelSession(parent.snapshot()), hasCode('MODEL_STATE_INVALID'))
      assert.throws(() => new SessionModelRunner({ session: parent, provider, limits: runnerLimits }), hasCode('MODEL_STATE_INVALID'))
      await assert.rejects(recoverModelInvocation(child, { invocationId, predecessorStopped: true, maxJournalConflicts: 1 }), hasCode('MODEL_STATE_INVALID'))
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
  test('S6-07: duplicate UUID and nonexistent retry reference do not overwrite existing input', async () => {
    const id = parseModelInvocationId('11111111-1111-4111-8111-111111111111'); const repo = repository(); const provider = scripted(); const session = await repo.create()
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits, identities: { nextInvocationId: () => id } })
    try {
      await runner.invoke(request()); await assert.rejects(runner.invoke(request()), hasCode('MODEL_STATE_INVALID')); assert.equal(session.snapshot().localPosition, 3)
      const other = new SessionModelRunner({ session, provider, limits: runnerLimits })
      try { await assert.rejects(other.invoke(request(), { retryOf: parseModelInvocationId('22222222-2222-4222-8222-222222222222') }), hasCode('MODEL_STATE_INVALID')); assert.equal(session.snapshot().localPosition, 3) }
      finally { await other.dispose().catch(() => undefined) }
    } finally { await runner.dispose().catch(() => undefined); await provider.dispose(); await repo.dispose() }
  })
  test('S6-15: abort after committed CP1 but before start keeps dispatch intent and records not-issued', async () => {
    const abort = new AbortController(); const inner = new MemorySessionBackend({ maxRecordBytes: 65536 }); let starts = 0
    const backend: SessionBackend = { get maxRecordBytes() { return inner.maxRecordBytes }, create: header => inner.create(header),
      openWriter: async id => { const writer = await inner.openWriter(id); return { ...writer, append: async (position, event) => { const result = await writer.append(position, event); if (event.type === modelStartedEvent.type) abort.abort(); return result } } }, readPrefix: (id, through) => inner.readPrefix(id, through), dispose: () => inner.dispose() }
    const repo = repository(backend); const provider = scripted({ script: async function* () { starts++; yield* textFrames() } }); const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try { const result = await runner.invoke(request(), { signal: abort.signal }); assert.equal(result.payload.outcome, 'cancelled'); assert.equal(result.payload.external, 'not-issued'); assert.equal(starts, 0); assert.equal(session.snapshot().localPosition, 3) }
    finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
  test('S6-35: known-not-written settlement failure rejects instead of returning a provider result', async () => {
    const inner = new MemorySessionBackend({ maxRecordBytes: 65536 }); const backend: SessionBackend = { get maxRecordBytes() { return inner.maxRecordBytes }, create: header => inner.create(header),
      openWriter: async id => { const writer = await inner.openWriter(id); return { ...writer, append: (position, event) => { if (event.type === modelSettledEvent.type) return Promise.reject(new SessionError('SESSION_RECORD_TOO_LARGE', 'injected known prewrite failure')); return writer.append(position, event) } } }, readPrefix: (id, through) => inner.readPrefix(id, through), dispose: () => inner.dispose() }
    const repo = repository(backend); const provider = scripted(); const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try { await assert.rejects(runner.invoke(request()), hasCode('MODEL_JOURNAL_WRITE_FAILED')); assert.equal(session.snapshot().localPosition, 2); assert.equal(runner.snapshot().invocations[0]?.state, 'started') }
    finally { await runner.dispose().catch(() => undefined); await provider.dispose(); await repo.dispose() }
  })
  test('S6-12/14: conflicting and out-of-order durable transitions fail closed on projection', async () => {
    const repo = repository(); const provider = scripted(); const session = await repo.create(); const id = parseModelInvocationId('11111111-1111-4111-8111-111111111111')
    try {
      await session.append(modelPreparedEvent, { invocationId: id, submission: provider.prepare(request()).submission, limits: runnerLimits })
      const payload = { invocationId: id, outcome: 'cancelled', external: 'not-issued', result: emptyModelResult(), cleanup: { status: 'complete', failedResources: 0 } } as const
      await session.append(modelSettledEvent, payload); await session.append(modelSettledEvent, payload)
      assert.throws(() => projectModelSession(session.snapshot()), hasCode('MODEL_STATE_INVALID'))
    } finally { await provider.dispose(); await repo.dispose() }
  })
}

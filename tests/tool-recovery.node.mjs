import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { h, fixture, toolLimits, catalog, descriptor, FaultBackend, toolEvents } from './helpers/tool-fixture.mjs'
import { createFileSessionBackendForTest } from '../dist/session/file-backend.js'
import { writeAll } from '../dist/session/file-store.js'

const definition = type => h.toolSessionEventDefinitions.find(event => event.type === type)
const requestEvent = definition('tool/invocation-requested'), authorizationEvent = definition('tool/authorization-decided')
const startedEvent = definition('tool/invocation-started'), settledEvent = definition('tool/invocation-settled')
const id = h.parseToolInvocationId('10000000-0000-0000-0000-000000000071')

async function seed(f, state) {
  const request = await f.session.append(requestEvent, { invocationId: id, source: { kind: 'direct' }, name: f.definition.name,
    arguments: { kind: 'json', value: { n: 1 } }, selection: { kind: 'resolved', definition: f.definition, provider: descriptor(f.definition) }, limits: toolLimits })
  if (state === 'requested') return { request }
  const plan = h.createPreparedToolPlan({ definition: f.definition, provider: descriptor(f.definition), input: { n: 1 }, limits: toolLimits,
    target: { kind: 'logical', resourceId: 'ledger' } })
  const authorization = await f.session.append(authorizationEvent, { invocationId: id, requestedEventId: request.stored.eventId,
    policy: { policyId: 'previous-instance', version: 1 }, decision: { kind: state === 'deny' ? 'deny' : 'allow', reasonCode: 'fixture' }, plan })
  if (state === 'started') await f.session.append(startedEvent, { invocationId: id, authorizationEventId: authorization.stored.eventId })
  return { request, authorization }
}
function facade(session, intercept) {
  return { get header() { return session.header }, get status() { return session.status }, get maxRecordBytes() { return session.maxRecordBytes },
    snapshot: () => session.snapshot(), supportsEventDefinition: value => session.supportsEventDefinition(value),
    appendIfPosition: async (position, event, payload) => { await intercept(event, payload); return session.appendIfPosition(position, event, payload) },
    append: session.append.bind(session), end: session.end.bind(session), dispose: session.dispose.bind(session), project: session.project.bind(session),
  }
}
for (const state of ['requested', 'deny', 'allow', 'started']) {
  test(`T7-33 explicit recovery of ${state} never calls policy or provider`, async () => fixture(async f => {
    await seed(f, state)
    assert.equal(f.trace.prepares, 0); assert.equal(f.trace.starts, 0)
    const result = await h.recoverToolSession(f.session, { predecessorStopped: true, maxJournalConflicts: 4 })
    assert.equal(result.payload.outcome, state === 'deny' ? 'rejected' : 'interrupted')
    assert.equal(result.payload.execution, state === 'started' ? 'may-have-executed' : 'not-started')
    if (state !== 'deny') { assert.equal(result.payload.cleanup.attempted, null); assert.equal(result.payload.cleanup.failed, null) }
    const position = f.session.snapshot().localPosition
    assert.equal(await h.recoverToolSession(f.session, { predecessorStopped: true, maxJournalConflicts: 4 }), null)
    assert.equal(f.session.snapshot().localPosition, position); assert.equal(f.trace.acquisitions, 0); assert.equal(f.trace.approvals, 0)
  }))
}

test('T7-54 competing recoveries converge on one terminal event without provider work', async () => fixture(async f => {
  await seed(f, 'allow')
  const results = await Promise.all([h.recoverToolSession(f.session, { predecessorStopped: true, maxJournalConflicts: 4 }),
    h.recoverToolSession(f.session, { predecessorStopped: true, maxJournalConflicts: 4 })])
  assert.equal(results[0].stored.eventId, results[1].stored.eventId)
  assert.equal(toolEvents(f.session).filter(e => e.stored.type === settledEvent.type).length, 1)
  assert.equal(f.trace.starts, 0)
}))

test('T7-54 recovery recalculates conservative evidence if started wins the CAS race', async () => fixture(async f => {
  const before = await seed(f, 'allow'); let once = false
  const session = facade(f.session, async event => {
    if (event === settledEvent && !once) { once = true; await f.session.append(startedEvent, { invocationId: id, authorizationEventId: before.authorization.stored.eventId }) }
  })
  const result = await h.recoverToolSession(session, { predecessorStopped: true, maxJournalConflicts: 4 })
  assert.equal(result.payload.execution, 'may-have-executed'); assert.equal(result.payload.emission, 'may-have-occurred')
  assert.equal(f.trace.starts, 0)
}))

for (const point of [requestEvent.type, authorizationEvent.type, startedEvent.type, settledEvent.type]) {
  test(`T7-49/50/51/53 unknown ${point} is recovered from a fresh File object graph`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'tool-unknown-'))
    let sessionId, trace
    try {
      let injected = false
      const backend = new FaultBackend(new h.FileSessionBackend({ root, maxRecordBytes: 262144 }), undefined, async event => {
        if (!injected && event.type === point) { injected = true; throw new h.SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'injected loss after committed append') }
      })
      await fixture(async f => {
        sessionId = f.session.header.sessionId; trace = f.trace
        await assert.rejects(f.runner.invoke({ name: 'echo', input: { n: 1 } }), { code: 'TOOL_JOURNAL_COMMIT_UNKNOWN' })
        assert.equal(f.runner.status, 'faulted'); assert.equal(f.session.status, 'faulted')
        assert.equal(f.trace.starts, point === settledEvent.type ? 1 : 0)
        await assert.rejects(Promise.resolve().then(() => f.repository.read(sessionId)), { code: 'SESSION_APPEND_OUTCOME_UNKNOWN' })
      }, { backend })
      const repository = new h.SessionRepository({ backend: new h.FileSessionBackend({ root, maxRecordBytes: 262144 }), catalog: catalog(), maxLineageDepth: 8 })
      try {
        const session = await repository.open(sessionId)
        const before = h.projectToolSession(session.snapshot())
        assert.equal(before.invocations.length, 1)
        if (point === settledEvent.type) {
          assert.equal(before.invocations[0].state, 'settled'); const position = session.snapshot().localPosition
          assert.equal(await h.recoverToolSession(session, { predecessorStopped: true, maxJournalConflicts: 4 }), null)
          assert.equal(session.snapshot().localPosition, position)
        } else {
          const recovered = await h.recoverToolSession(session, { predecessorStopped: true, maxJournalConflicts: 4 })
          assert.equal(recovered.payload.outcome, 'interrupted')
          assert.equal(recovered.payload.execution, point === startedEvent.type ? 'may-have-executed' : 'not-started')
        }
        assert.equal(trace.starts, point === settledEvent.type ? 1 : 0)
      } finally { await repository.dispose() }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

test('T7-51 a real File sync confirmation loss at CP1 reopens as may-have-executed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool-sync-unknown-')); let sessionId, trace, syncs = 0
  try {
    const options = { root, maxRecordBytes: 262144 }
    const backend = createFileSessionBackendForTest(options, {
      writeAll,
      sync: async handle => {
        await handle.sync(); syncs++
        if (syncs === 3) throw new Error('injected lost sync confirmation')
      },
    })
    await fixture(async f => {
      sessionId = f.session.header.sessionId; trace = f.trace
      await assert.rejects(f.runner.invoke({ name: 'echo', input: { n: 1 } }), { code: 'TOOL_JOURNAL_COMMIT_UNKNOWN' })
      assert.equal(f.runner.status, 'faulted'); assert.equal(f.session.status, 'faulted')
      assert.equal(f.trace.starts, 0)
    }, { backend })
    assert.equal(syncs, 3)
    const repository = new h.SessionRepository({ backend: new h.FileSessionBackend(options), catalog: catalog(), maxLineageDepth: 8 })
    try {
      const session = await repository.open(sessionId)
      const before = h.projectToolSession(session.snapshot())
      assert.equal(before.invocations[0].state, 'started')
      const recovered = await h.recoverToolSession(session, { predecessorStopped: true, maxJournalConflicts: 4 })
      assert.equal(recovered.payload.outcome, 'interrupted')
      assert.equal(recovered.payload.execution, 'may-have-executed')
      assert.equal(recovered.payload.emission, 'may-have-occurred')
      assert.equal(trace.starts, 0)
    } finally { await repository.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('T7-50 committed Tool facts survive a legal incomplete File tail and a new writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool-tail-')); let before, sessionId
  try {
    await fixture(async f => {
      await f.runner.invoke({ name: 'echo', input: { n: 1 } }); before = f.runner.snapshot(); sessionId = f.session.header.sessionId
    }, { backend: new h.FileSessionBackend({ root, maxRecordBytes: 262144 }) })
    const path = join(root, 'sessions', sessionId, 'events.log'), complete = await readFile(path)
    await appendFile(path, '12\t')
    const repository = new h.SessionRepository({ backend: new h.FileSessionBackend({ root, maxRecordBytes: 262144 }), catalog: catalog(), maxLineageDepth: 8 })
    try {
      const session = await repository.open(sessionId)
      assert.deepEqual(h.projectToolSession(session.snapshot()), before)
      assert.deepEqual(await readFile(path), complete)
    } finally { await repository.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('T7-52 CP2 definite write failure never repeats an already observed external effect', async () => {
  const backend = new FaultBackend(new h.MemorySessionBackend({ maxRecordBytes: 262144 }), event => {
    if (event.type === settledEvent.type) throw new h.SessionError('SESSION_RECORD_TOO_LARGE', 'injected definite pre-write failure')
  })
  await fixture(async f => {
    await assert.rejects(f.runner.invoke({ name: 'echo', input: { n: 1 } }), { code: 'TOOL_JOURNAL_WRITE_FAILED' })
    assert.equal(f.trace.ledger, 1); assert.equal(f.trace.closes, 1)
    assert.equal(f.runner.snapshot().invocations[0].state, 'started')
    assert.throws(() => f.runner.invoke({ name: 'echo', input: { n: 2 } }), { code: 'TOOL_RUNNER_INACTIVE' })
    assert.equal(f.trace.ledger, 1)
  }, { backend })
})

test('T7-41/52 CP2 failure retains the independent cleanup-incomplete fact', async () => {
  const backend = new FaultBackend(new h.MemorySessionBackend({ maxRecordBytes: 262144 }), undefined, event => {
    if (event.type === settledEvent.type) throw new h.SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'injected loss after committed settlement')
  })
  await fixture(async f => {
    await assert.rejects(f.runner.invoke({ name: 'echo', input: { n: 1 } }), error => {
      assert.equal(error.code, 'TOOL_JOURNAL_COMMIT_UNKNOWN')
      assert.equal(error.details.cleanupIncomplete, true)
      return true
    })
    assert.equal(f.trace.ledger, 1); assert.equal(f.trace.closes, 1)
    assert.equal(f.runner.status, 'faulted')
    await assert.rejects(f.runner.dispose(), { code: 'TOOL_CLEANUP_FAILED' })
    await assert.rejects(f.provider.dispose(), { code: 'TOOL_CLEANUP_FAILED' })
  }, { backend, close: () => { throw new Error('private cleanup failure') }, allowCleanupFailure: true })
})

const tick = h.createDurableEventDefinition({ type: 'research/tick', payloadVersion: 1, ignorable: false, decode: value => value })
test('T7-47 unrelated appends retry only local journal work, not policy or execution', async () => fixture(async f => {
  const seen = new Set()
  const session = facade(f.session, async event => {
    if (!seen.has(event.type)) { seen.add(event.type); await f.session.append(tick, { n: seen.size }) }
  })
  const runner = f.makeRunner({ session })
  const result = await runner.invoke({ name: 'echo', input: { n: 1 } })
  assert.equal(result.payload.outcome, 'succeeded'); assert.equal(f.trace.approvals, 1); assert.equal(f.trace.starts, 1)
  assert.equal(f.session.snapshot().localPosition, 8); assert.equal(f.session.status, 'open')
}, { catalog: catalog([tick]) }))

test('T7-48 finite CAS exhaustion releases admission and leaves the actual Writer healthy', async () => fixture(async f => {
  let changes = 0
  const session = facade(f.session, async () => { await f.session.append(tick, { n: ++changes }) })
  const runner = f.makeRunner({ session, limits: { ...toolLimits, maxJournalConflicts: 1 } })
  await assert.rejects(runner.invoke({ name: 'echo', input: { n: 1 } }), { code: 'TOOL_SESSION_CHANGED' })
  assert.equal(changes, 2); assert.equal(f.session.status, 'open'); assert.equal(f.trace.starts, 0)
  assert.equal(f.registry.snapshot()[0].inFlight, 0); assert.equal(toolEvents(f.session).length, 0)
}, { catalog: catalog([tick]) }))

for (const mutation of ['duplicate-request', 'start-without-allow', 'deny-then-start', 'duplicate-settlement']) {
  test(`T7-55 replay rejects ${mutation} instead of taking the last record`, async () => fixture(async f => {
    const seeded = await seed(f, mutation === 'deny-then-start' ? 'deny' : 'requested')
    if (mutation === 'duplicate-request') await f.session.append(requestEvent, seeded.request.payload)
    else if (mutation === 'start-without-allow' || mutation === 'deny-then-start') await f.session.append(startedEvent, {
      invocationId: id, authorizationEventId: seeded.authorization?.stored.eventId ?? seeded.request.stored.eventId })
    else {
      const settled = await h.recoverToolSession(f.session, { predecessorStopped: true, maxJournalConflicts: 4 })
      await f.session.append(settledEvent, settled.payload)
    }
    assert.throws(() => h.projectToolSession(f.session.snapshot()), { code: 'TOOL_STATE_INVALID' })
    assert.equal(f.trace.starts, 0)
  }))
}

test('T7-55 a known future Tool event version still fails the current Tool projection closed', async () => {
  const future = h.createDurableEventDefinition({ type: requestEvent.type, payloadVersion: 2, ignorable: true, decode: value => value })
  await fixture(async f => {
    await f.session.append(future, {})
    assert.throws(() => h.projectToolSession(f.session.snapshot()), { code: 'TOOL_STATE_INVALID' })
  }, { catalog: catalog([future]) })
})

test('T7-56 Fork does not inherit pending work or authorization', async () => fixture(async f => {
  await seed(f, 'allow')
  const child = await f.repository.fork(f.session.header.sessionId)
  assert.equal(h.projectToolSession(child.snapshot()).invocations.length, 0)
  const runner = f.makeRunner({ session: child })
  assert.equal((await runner.invoke({ name: 'echo', input: { n: 2 } })).payload.outcome, 'succeeded')
  assert.equal(f.runner.snapshot().invocations[0].state, 'decided')
  await h.recoverToolSession(f.session, { predecessorStopped: true, maxJournalConflicts: 4 })
  assert.equal(f.trace.starts, 1)
}))

test('T7-57 privileged Session end with pending Tool work is stranded and not repaired', async () => fixture(async f => {
  await seed(f, 'requested'); await f.session.end('privileged-bypass')
  const position = f.session.snapshot().localPosition
  assert.throws(() => h.projectToolSession(f.session.snapshot()), { code: 'TOOL_STATE_INVALID' })
  await assert.rejects(h.recoverToolSession(f.session, { predecessorStopped: true, maxJournalConflicts: 4 }), { code: 'TOOL_STATE_INVALID' })
  assert.equal(f.session.snapshot().localPosition, position); assert.equal(f.trace.starts, 0)
}))

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import {
  createDurableEventCatalog, createDurableEventDefinition, FileSessionBackend, MemorySessionBackend,
  SessionRepository, sessionEndedEvent, sessionLogPosition,
} from '../dist/index.js'

const observation = createDurableEventDefinition({ type: 'built/observation', payloadVersion: 1, ignorable: false, decode: value => value })
const repository = backend => new SessionRepository({ backend, catalog: createDurableEventCatalog([observation]), maxLineageDepth: 2 })

async function withRoot(run) {
  const parent = tmpdir(), root = await mkdtemp(join(parent, 'atomic-session-built-'))
  try { await run(root) }
  finally { assert.equal(dirname(root), parent); await rm(root, { recursive: true, force: true }) }
}

test('built terminal append shares end, survives restart, and leaves a fork active', async () => {
  await withRoot(async root => {
    const first = repository(new FileSessionBackend({ root, maxRecordBytes: 4096 }))
    let second
    try {
      const session = await first.create()
      const accepted = session.append(observation, { text: 'committed' })
      const ended = session.appendIfPosition(sessionLogPosition(1), sessionEndedEvent, { reason: 'complete' })
      assert.equal(session.end(), ended)
      assert.throws(() => session.append(observation, {}), { code: 'SESSION_ENDED' })
      await accepted
      const terminal = await ended, before = session.snapshot()
      const child = await first.fork(session.header.sessionId)
      await child.append(observation, { text: 'child' })
      assert.equal(child.snapshot().lifecycle, 'active')
      const childId = child.header.sessionId
      await first.dispose()
      second = repository(new FileSessionBackend({ root, maxRecordBytes: 4096 }))
      const reopened = await second.open(session.header.sessionId)
      assert.deepEqual(reopened.snapshot(), before)
      assert.deepEqual(await reopened.end(), terminal)
      assert.equal((await second.read(childId)).lifecycle, 'active')
    } finally { await second?.dispose(); await first.dispose() }
  })
})

test('built public Writers capture admitted data and reject lossy JSON without writing', async () => {
  await withRoot(async root => {
    for (const backend of [new MemorySessionBackend({ maxRecordBytes: 4096 }), new FileSessionBackend({ root, maxRecordBytes: 4096 })]) {
      const sessions = repository(backend)
      try {
        const handle = await sessions.create(), id = handle.header.sessionId
        const template = (await handle.append(observation, {})).stored
        await handle.dispose()
        const writer = await backend.openWriter(id)
        const stored = { ...template, sequence: 2, eventId: template.eventId.replace(/:1$/, ':2') }
        const payload = { values: [1] }
        const committed = writer.append(sessionLogPosition(1), { ...stored, payload })
        payload.values.push(9)
        assert.equal(await committed, 2)
        assert.deepEqual((await writer.readCommitted()).events[1].payload, { values: [1] })
        await assert.rejects(writer.append(sessionLogPosition(2), { ...stored, payload: { value: NaN } }), { code: 'SESSION_EVENT_INVALID' })
        assert.equal((await writer.readCommitted()).position, 2)
        await writer.dispose()
      } finally { await sessions.dispose() }
    }
  })
})

test('built Reader and Writer preserve a damaged partial frame byte', async () => {
  await withRoot(async root => {
    const sessions = repository(new FileSessionBackend({ root, maxRecordBytes: 4096 }))
    const backend = new FileSessionBackend({ root, maxRecordBytes: 4096 })
    try {
      const handle = await sessions.create(), id = handle.header.sessionId
      await handle.append(observation, { value: 1 })
      await sessions.dispose()
      const path = join(root, 'sessions', id, 'events.log')
      const original = await readFile(path), damaged = Buffer.from([original[0] | 0x80])
      await writeFile(path, damaged)
      await assert.rejects(backend.readPrefix(id), { code: 'SESSION_LOG_INVALID' })
      await assert.rejects(backend.openWriter(id), { code: 'SESSION_LOG_INVALID' })
      assert.deepEqual(await readFile(path), damaged)
    } finally { await backend.dispose(); await sessions.dispose() }
  })
})

async function releasedHandle() {
  const backend = new MemorySessionBackend({ maxRecordBytes: 4096 }), sessions = repository(backend)
  const handle = await sessions.create()
  await handle.append(observation, { text: 'retired' })
  const refs = [new WeakRef(backend), new WeakRef(sessions), new WeakRef(handle.snapshot().history)]
  await sessions.dispose()
  return { handle, refs }
}

test('built disposed Handles retain metadata without keeping Repository or log history', async () => {
  const { handle, refs } = await releasedHandle()
  await setImmediate()
  queryObjects(SessionRepository, { format: 'count' })
  assert.equal(handle.status, 'disposed')
  assert.ok(handle.header.sessionId)
  assert.equal(handle.supportsEventDefinition(observation), true)
  assert.throws(() => handle.snapshot(), { code: 'SESSION_HANDLE_INACTIVE' })
  assert.deepEqual(refs.map(ref => ref.deref()), [undefined, undefined, undefined])
})

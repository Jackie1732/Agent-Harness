import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import {
  createDurableEventCatalog,
  createDurableEventDefinition,
  formatSessionAddress,
  formatSessionEventId,
  MemorySessionBackend,
  parseSessionId,
  SessionRepository,
  sessionLogPosition,
  sessionSequence,
} from '../dist/index.js'

const id = parseSessionId('00000000-0000-4000-8000-000000000182')
const header = { formatVersion: 1, sessionId: id, address: formatSessionAddress(id), createdAt: '2026-10-13T00:00:00.000Z' }
const definition = createDurableEventDefinition({ type: 'test/recorded', payloadVersion: 1, ignorable: false, decode: value => value })
const catalog = createDurableEventCatalog([definition])

async function retainedOwner(kind, keepSnapshot = false) {
  const backend = new MemorySessionBackend({ maxRecordBytes: 4096 })
  if (kind === 'repository') {
    const repository = new SessionRepository({ backend, catalog, maxLineageDepth: 1 })
    const handle = await repository.create()
    await handle.append(definition, { nested: { value: 1 } })
    const saved = await backend.readPrefix(handle.header.sessionId)
    const reference = new WeakRef(saved.events[0].payload)
    await repository.dispose()
    assert.equal(handle.status, 'disposed')
    return { keeper: repository, reference }
  }
  await backend.create(header)
  const writer = await backend.openWriter(id)
  await writer.append(sessionLogPosition(0), { envelopeVersion: 1, sessionId: id, eventId: formatSessionEventId(id, sessionSequence(1)),
    sequence: sessionSequence(1), recordedAt: header.createdAt, type: definition.type, payloadVersion: 1, payload: { nested: { value: 1 } } })
  const saved = await writer.readCommitted()
  const reference = new WeakRef(saved.events[0].payload)
  await writer.dispose()
  assert.equal((await backend.readPrefix(id)).position, 1)
  await backend.dispose()
  return { keeper: kind === 'backend' ? backend : writer, reference, snapshot: keepSnapshot ? saved : undefined }
}

async function collect() {
  await setImmediate()
  queryObjects(MemorySessionBackend, { format: 'count' })
  await setImmediate()
  queryObjects(MemorySessionBackend, { format: 'count' })
}

for (const kind of ['backend', 'repository', 'writer']) {
  test(`retires stored payloads while a disposed Memory ${kind} remains observable`, async () => {
    const { keeper, reference } = await retainedOwner(kind)
    await collect()
    assert.notEqual(keeper, undefined)
    assert.equal(reference.deref(), undefined, `disposed ${kind} retains its private stored payload`)
  })
}

test('preserves an explicitly retained frozen prefix independently of Memory Backend retirement', async () => {
  const { keeper, reference, snapshot } = await retainedOwner('backend', true)
  await collect()
  assert.notEqual(keeper, undefined)
  assert.equal(snapshot.position, 1)
  assert.equal(snapshot.events.length, 1)
  assert.equal(reference.deref(), snapshot.events[0].payload)
  assert.deepEqual(snapshot.events[0].payload, { nested: { value: 1 } })
  assert.equal(Object.isFrozen(snapshot.events), true)
  assert.equal(Object.isFrozen(snapshot.events[0].payload), true)
})

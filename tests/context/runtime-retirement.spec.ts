import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import {
  FileSessionBackend, SessionContext, ToolRegistry, communicationSessionEventDefinitions,
  createMessageCatalog, createMessageDefinition, decodeMessageEnvelope, formatSessionAddress,
  messageEnvelopeDigest, parseChannelId, parseMessageId, parseSessionId, projectContextSession,
} from '../../src/index.js'
import type { JsonValue } from '../../src/index.js'
import { inboxAcceptedEvent } from '../../src/communication/session-events.js'
import { createFileSessionBackendForTest } from '../../src/session/file-backend.js'
import { writeAll } from '../../src/session/file-store.js'
import { emptyMessageCatalog, profile, repository, scriptedModel, selection } from './fixtures.js'

let cancelAtDecode: (() => void) | undefined
function cancelledPayload(value: JsonValue): JsonValue { cancelAtDecode?.(); return value }

function peerEnvelope(recipient: string, type: string) {
  const messageId = parseMessageId('50000000-0000-4000-8000-000000000111')
  return decodeMessageEnvelope({ envelopeVersion: 1, messageId,
    sender: formatSessionAddress(parseSessionId('30000000-0000-4000-8000-000000000299')),
    recipient, channelId: parseChannelId('40000000-0000-4000-8000-000000000111'),
    channelSequence: 1, correlationId: messageId, createdAt: '2026-10-11T00:00:00.000Z',
    type, payloadVersion: 1, payload: 'peer data' })
}

async function releasedContext(record: boolean, keepSnapshot: boolean) {
  const repo = repository()
  const session = await repo.create()
  const catalog = createMessageCatalog([createMessageDefinition({ type: 'retirement', payloadVersion: 1, decode: value => value })])
  const registry = new ToolRegistry({ maxSchemaBytes: 16_384, maxSchemaDepth: 16, maxSchemaNodes: 512 })
  const lifetime = new AbortController()
  const context = new SessionContext({ session, messageCatalog: catalog, toolRegistry: registry, signal: lifetime.signal })
  if (record) await context.recordProfile(profile())
  const snapshot = keepSnapshot ? context.snapshot() : undefined
  const refs = { session: new WeakRef(session), catalog: new WeakRef(catalog), registry: new WeakRef(registry), signal: new WeakRef(lifetime.signal) }
  const close = context.dispose()
  await close
  expect(session.status).toBe('open')
  await registry.dispose()
  await repo.dispose()
  return { context, snapshot, close, refs }
}

it.each([[false, false], [true, false], [true, true]])('retires borrowed Context runtime: record=%s, retained snapshot=%s', async (record, keepSnapshot) => {
  const { context, snapshot, close, refs } = await releasedContext(record, keepSnapshot)
  await setImmediate()
  queryObjects(SessionContext, { format: 'count' })
  expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined]))).toEqual({
    session: false, catalog: false, registry: false, signal: false,
  })
  expect(context.status).toBe('disposed')
  expect(context.dispose()).toBe(close)
  expect(() => context.snapshot()).toThrowError(expect.objectContaining({ code: 'CONTEXT_INACTIVE' }))
  expect(() => context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'test', text: 'late' }))
    .toThrowError(expect.objectContaining({ code: 'CONTEXT_INACTIVE' }))
  if (keepSnapshot) {
    assert(snapshot !== undefined)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot.profiles[0]?.payload.profileKey).toBe('generation')
  } else expect(snapshot).toBeUndefined()
})

async function faultedContext() {
  const root = await mkdtemp(join(tmpdir(), 'atomic-context-retirement-'))
  const repo = repository(createFileSessionBackendForTest({ root, maxRecordBytes: 2 * 1024 * 1024 }, {
    writeAll,
    sync: async file => { await file.sync(); throw new Error('lost acknowledgement') },
  }))
  try {
    const session = await repo.create()
    const catalog = createMessageCatalog()
    const lifetime = new AbortController()
    const context = new SessionContext({ session, messageCatalog: catalog, signal: lifetime.signal })
    const pending = context.recordProfile(profile())
    await assert.rejects(pending, { code: 'CONTEXT_JOURNAL_COMMIT_UNKNOWN' })
    const sessionId = session.header.sessionId
    const close = context.dispose()
    await assert.rejects(close, { code: 'CONTEXT_JOURNAL_COMMIT_UNKNOWN' })
    expect(session.status).toBe('faulted')
    const refs = { session: new WeakRef(session), catalog: new WeakRef(catalog), signal: new WeakRef(lifetime.signal) }
    await repo.dispose()
    const reopenedRepo = repository(new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }))
    let snapshot
    try { snapshot = projectContextSession((await reopenedRepo.open(sessionId)).snapshot()) }
    finally { await reopenedRepo.dispose() }
    return { context, pending, close, snapshot, refs }
  } finally { await rm(root, { recursive: true, force: true }) }
}

it('retires runtime after a lost File acknowledgement while preserving rejected tasks and committed facts', async () => {
  const { context, pending, close, snapshot, refs } = await faultedContext()
  await setImmediate()
  queryObjects(SessionContext, { format: 'count' })
  expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined])))
    .toEqual({ session: false, catalog: false, signal: false })
  expect(context.status).toBe('disposed')
  expect(context.dispose()).toBe(close)
  await expect(pending).rejects.toMatchObject({ code: 'CONTEXT_JOURNAL_COMMIT_UNKNOWN' })
  await expect(close).rejects.toMatchObject({ code: 'CONTEXT_JOURNAL_COMMIT_UNKNOWN' })
  expect(snapshot.profiles[0]?.payload.profileKey).toBe('generation')
})

it('samples the operation signal once at admission', async () => {
  const repo = repository()
  try {
    const session = await repo.create()
    const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
    const controller = new AbortController()
    let reads = 0
    await context.recordProfile(profile(), { get signal() { reads += 1; return controller.signal } })
    expect(reads).toBe(1)
    await context.dispose()
    expect(session.snapshot().localPosition).toBe(1)
  } finally { await repo.dispose() }
})

it('keeps the admitted cancellation signal when a decoder replaces the caller options', async () => {
  const controller = new AbortController()
  const options = { signal: controller.signal }
  const definition = createMessageDefinition({ type: 'context/signal', payloadVersion: 1, decode: value => {
    controller.abort()
    options.signal = new AbortController().signal
    return value
  } })
  const repo = repository(undefined, communicationSessionEventDefinitions)
  const provider = scriptedModel()
  try {
    const session = await repo.create()
    const context = new SessionContext({ session, messageCatalog: createMessageCatalog([definition]) })
    const recorded = await context.recordProfile(profile())
    const envelope = peerEnvelope(session.header.address, definition.type)
    await session.append(inboxAcceptedEvent, { envelope, digest: messageEnvelopeDigest(envelope) })
    const position = session.snapshot().localPosition
    await expect(context.assemble(selection(recorded.stored.eventId, provider.descriptor, {
      inbox: [{ messageId: envelope.messageId, action: 'include-full' }],
    }), options)).rejects.toMatchObject({ code: 'CONTEXT_INACTIVE' })
    expect(session.snapshot().localPosition).toBe(position)
    expect(context.status).toBe('accepting')
    await context.dispose()
  } finally { await provider.dispose(); await repo.dispose() }
})

async function cancelledContext() {
  const repo = repository(undefined, communicationSessionEventDefinitions)
  const session = await repo.create()
  const catalog = createMessageCatalog([createMessageDefinition({ type: 'context/cancelled', payloadVersion: 1, decode: cancelledPayload })])
  const registry = new ToolRegistry({ maxSchemaBytes: 16_384, maxSchemaDepth: 16, maxSchemaNodes: 512 })
  const lifetime = new AbortController(), operation = new AbortController()
  const context = new SessionContext({ session, messageCatalog: catalog, toolRegistry: registry, signal: lifetime.signal })
  const provider = scriptedModel()
  try {
    const recorded = await context.recordProfile(profile())
    const envelope = peerEnvelope(session.header.address, 'context/cancelled')
    await session.append(inboxAcceptedEvent, { envelope, digest: messageEnvelopeDigest(envelope) })
    const position = session.snapshot().localPosition
    cancelAtDecode = operation.abort.bind(operation)
    const pending = context.assemble(selection(recorded.stored.eventId, provider.descriptor, {
      inbox: [{ messageId: envelope.messageId, action: 'include-full' }],
    }), { signal: operation.signal })
    let failure: unknown
    try { await pending } catch (reason) { failure = reason }
    expect(session.snapshot().localPosition).toBe(position)
    const close = context.dispose()
    await close
    const refs = { session: new WeakRef(session), catalog: new WeakRef(catalog), registry: new WeakRef(registry),
      lifetime: new WeakRef(lifetime.signal), operation: new WeakRef(operation.signal) }
    return { context, pending, close, failure, refs }
  } finally {
    cancelAtDecode = undefined
    await context.dispose(); await provider.dispose(); await registry.dispose(); await repo.dispose()
  }
}

it('retires runtime with the original cancellation Error and rejected task retained', async () => {
  const { context, pending, close, failure, refs } = await cancelledContext()
  await setImmediate()
  queryObjects(SessionContext, { format: 'count' })
  expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined])))
    .toEqual({ session: false, catalog: false, registry: false, lifetime: false, operation: false })
  expect(context.status).toBe('disposed')
  expect(context.dispose()).toBe(close)
  await assert.rejects(pending, reason => reason === failure)
  expect(failure).toMatchObject({ code: 'CONTEXT_INACTIVE' })
})

it('closes Context admission when the borrowed Session has ended', async () => {
  const repo = repository()
  try {
    const session = await repo.create()
    const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
    await session.end('completed')
    const position = session.snapshot().localPosition
    expect(() => context.recordProfile(profile())).toThrowError(expect.objectContaining({ code: 'CONTEXT_INACTIVE' }))
    expect(session.snapshot().localPosition).toBe(position)
    await context.dispose()
    expect(session.status).toBe('open')
  } finally { await repo.dispose() }
})

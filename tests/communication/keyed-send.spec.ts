import { expect, it } from 'vitest'
import { CommunicationService, MemorySessionBackend, SessionRepository, allowAllCommunicationPolicy, communicationSessionEventDefinitions,
  createDurableEventCatalog, createDurableEventDefinition, createInProcessMessageTransport, createMessageCatalog, createMessageDefinition,
  createSessionDirectory, parseChannelId, projectCommunicationFacts } from '../../src/index.js'
import type { CommunicationPolicy, MessageCatalog, SessionBackend } from '../../src/index.js'
import { channelIds, communicationIdentities, limits, loseFirstCommitAcknowledgement, messageCatalog, requestMessage, sessionIdentities } from './fixtures.js'

const commandEvent = createDurableEventDefinition({ type: 'test/command', payloadVersion: 1, ignorable: false, decode: value => value })
const content = { type: requestMessage.type, payloadVersion: 1, payload: { text: 'hello' } }

async function fixture(backend: SessionBackend = new MemorySessionBackend({ maxRecordBytes: 32768 })) {
  const repo = new SessionRepository({ backend, catalog: createDurableEventCatalog([...communicationSessionEventDefinitions, commandEvent]),
    maxLineageDepth: 4, identitySource: sessionIdentities() })
  const session = await repo.create()
  const peer = await repo.create()
  const source = await session.append(commandEvent, { command: 'send' })
  const key = { eventId: source.stored.eventId, index: 0 }
  const request = { kind: 'root' as const, recipient: peer.header.address, channelId: parseChannelId(channelIds[0]) }
  const services: CommunicationService[] = []
  async function attach(catalog: MessageCatalog = messageCatalog, policy: CommunicationPolicy = allowAllCommunicationPolicy) {
    const directory = createSessionDirectory()
    const service = new CommunicationService({ directory, transport: createInProcessMessageTransport(directory), limits, identitySource: communicationIdentities() })
    services.push(service)
    return { service, mailbox: await service.attach(session, { catalog, policy }) }
  }
  return { repo, session, peer, key, request, attach, dispose: async () => {
    for (const service of services) await service.dispose()
    await repo.dispose()
  } }
}

it('returns the original acceptance before decoding or authorization and rejects a changed raw command', async () => {
  const f = await fixture()
  let decodes = 0, policies = 0
  const definition = createMessageDefinition({ type: 'test/normalized', payloadVersion: 1, decode: () => { decodes++; return { normalized: true } } })
  const policy: CommunicationPolicy = { canSend: () => { policies++; return { kind: 'allow' } }, canReceive: () => ({ kind: 'allow' }) }
  try {
    const { mailbox } = await f.attach(createMessageCatalog([definition]), policy)
    const raw = { type: definition.type, payloadVersion: 1, payload: { a: 1, b: 2 } }
    const first = await mailbox.sendOnce(f.key, f.request, raw)
    const repeated = await mailbox.sendOnce({ index: 0, eventId: f.key.eventId }, f.request, { ...raw, payload: { b: 2, a: 1 } })
    expect(repeated).toEqual(first)
    expect({ decodes, policies }).toEqual({ decodes: 1, policies: 1 })
    await expect(mailbox.sendOnce(f.key, f.request, { ...raw, payload: { a: 2 } })).rejects.toMatchObject({ code: 'MESSAGE_SEND_KEY_CONFLICT' })
    expect(decodes).toBe(1)
    expect(projectCommunicationFacts(f.session.snapshot()).outbox[0]).toMatchObject({ command: { payload: { a: 1, b: 2 } }, envelope: { payload: { normalized: true } } })
  } finally { await f.dispose() }
})

it('reads the accepted command after its decoder is removed and the current policy denies new sends', async () => {
  const f = await fixture()
  try {
    const first = await f.attach()
    const original = await first.mailbox.sendOnce(f.key, f.request, content)
    await first.service.dispose()
    const replacement = await f.attach(createMessageCatalog(), { canSend: () => { throw new Error('must not call policy') }, canReceive: () => ({ kind: 'deny', reasonCode: 'disabled' }) })
    expect(await replacement.mailbox.sendOnce(f.key, f.request, content)).toEqual(original)
  } finally { await f.dispose() }
})

it('uses conditional acceptance across independent mailbox objects sharing the same handle', async () => {
  const f = await fixture()
  try {
    const a = await f.attach(), b = await f.attach()
    const [left, right] = await Promise.all([a.mailbox.sendOnce(f.key, f.request, content), b.mailbox.sendOnce(f.key, f.request, content)])
    expect(left).toEqual(right)
    expect(projectCommunicationFacts(f.session.snapshot()).outbox).toHaveLength(1)
  } finally { await f.dispose() }
})

it('keeps a single channel sequence across concurrent keyed and ordinary sends', async () => {
  const f = await fixture()
  try {
    const { mailbox } = await f.attach()
    await Promise.all([mailbox.sendOnce(f.key, f.request, content), mailbox.send(requestMessage, f.request, { text: 'ordinary' })])
    expect(mailbox.snapshot().outbox.map(item => item.envelope.channelSequence)).toEqual([1, 2])
    expect(f.session.snapshot().history.at(-1)!.events.filter(event => event.stored.type === 'communication/outbox-accepted').map(event => event.stored.payloadVersion)).toEqual([2, 1])
  } finally { await f.dispose() }
})

it('rechecks shared capacity after another mailbox wins its conditional append', async () => {
  const f = await fixture()
  const directories = [createSessionDirectory(), createSessionDirectory()]
  const services = directories.map(directory => new CommunicationService({ directory, transport: createInProcessMessageTransport(directory),
    limits: { ...limits, maxPendingOutbox: 1 } }))
  try {
    const [a, b] = await Promise.all(services.map(service => service.attach(f.session, { catalog: messageCatalog, policy: allowAllCommunicationPolicy })))
    const results = await Promise.allSettled([a!.sendOnce(f.key, f.request, content), b!.sendOnce({ ...f.key, index: 1 }, f.request, content)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'MESSAGE_OUTBOX_FULL' } })
    expect(projectCommunicationFacts(f.session.snapshot()).outbox).toHaveLength(1)
  } finally { for (const service of services) await service.dispose(); await f.dispose() }
})

it('recovers a lost acceptance acknowledgement from its key without a second message', async () => {
  const backend = loseFirstCommitAcknowledgement(new MemorySessionBackend({ maxRecordBytes: 32768 }), 'communication/outbox-accepted')
  const f = await fixture(backend)
  const directory = createSessionDirectory()
  const service = new CommunicationService({ directory, transport: createInProcessMessageTransport(directory), limits })
  try {
    const first = await f.attach()
    await expect(first.mailbox.sendOnce(f.key, f.request, content)).rejects.toMatchObject({ code: 'MESSAGE_OUTBOX_COMMIT_UNKNOWN' })
    await first.service.dispose()
    await f.session.dispose()
    const reopened = await f.repo.open(f.session.header.sessionId)
    const mailbox = await service.attach(reopened, { catalog: messageCatalog, policy: allowAllCommunicationPolicy })
    const accepted = await mailbox.sendOnce(f.key, f.request, content)
    expect(projectCommunicationFacts(reopened.snapshot()).outbox).toHaveLength(1)
    expect(accepted.outboxEventId).toBe(projectCommunicationFacts(reopened.snapshot()).outbox[0]!.acceptedEventId)
  } finally { await service.dispose(); await f.dispose() }
})

import { expect, it } from 'vitest'
import { SessionContext, SessionModelRunner } from '../../src/index.js'
import { emptyMessageCatalog, profile, repository, runnerLimits, scriptedModel, selection } from '../context/fixtures.js'
import { channelIds, createCommunicationService, createRepository, messageCatalog, requestMessage } from '../communication/fixtures.js'
import { parseChannelId } from '../../src/communication/ids.js'

it('requires a new cut after any write between a committed assembly and model adoption', async () => {
  const repo = repository()
  const counters = { prepare: 0, acquire: 0, start: 0 }
  const provider = scriptedModel('unused', counters)
  const session = await repo.create()
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
  const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
  try {
    const p = await context.recordProfile(profile())
    const input = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'baseline', text: 'claimed task' })
    const built = await context.assemble(selection(p.stored.eventId, provider.descriptor, {
      requiredInputs: [{ eventId: input.stored.eventId, selector: 'user-input' }],
    }))
    if (built.kind !== 'ready') throw new Error('fixture assembly')
    await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'baseline', text: 'later input' })
    await expect(runner.invoke(built.request, { inputPrecondition: built.inputPrecondition })).rejects.toMatchObject({ code: 'MODEL_INPUT_STALE' })
    expect(counters).toEqual({ prepare: 0, acquire: 0, start: 0 })
  } finally { await runner.dispose(); await context.dispose(); await provider.dispose(); await repo.dispose() }
})

it('exposes legacy suffix selection as insufficient for Agent input isolation', async () => {
  const repo = repository()
  const provider = scriptedModel()
  const session = await repo.create()
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
  try {
    const p = await context.recordProfile(profile())
    const first = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'baseline', text: 'current task' })
    await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'baseline', text: 'queued secret' })
    const built = await context.assemble(selection(p.stored.eventId, provider.descriptor, {
      requiredInputs: [{ eventId: first.stored.eventId, selector: 'user-input' }],
    }))
    if (built.kind !== 'ready') throw new Error('fixture assembly')
    expect(JSON.stringify(built.request)).toContain('queued secret')
  } finally { await context.dispose(); await provider.dispose(); await repo.dispose() }
})

it('preserves distinct ordinary sends with the same content, requiring a separate command identity for recovery', async () => {
  const repo = createRepository()
  const { service, policy } = createCommunicationService()
  try {
    const session = await repo.create()
    const peer = await repo.create()
    const mailbox = await service.attach(session, { catalog: messageCatalog, policy })
    const request = { kind: 'root' as const, recipient: peer.header.address, channelId: parseChannelId(channelIds[0]) }
    const a = await mailbox.send(requestMessage, request, { text: 'same command body' })
    const b = await mailbox.send(requestMessage, request, { text: 'same command body' })
    expect(a.messageId).not.toBe(b.messageId)
    expect(mailbox.snapshot().outbox).toHaveLength(2)
  } finally { await service.dispose(); await repo.dispose() }
})

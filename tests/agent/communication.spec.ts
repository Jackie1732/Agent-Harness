import { expect, it } from 'vitest'
import { SessionContext, SessionModelRunner, ScriptedModelProvider, SessionAgent, installAgentSpec, parseChannelId,
  parseSessionId, formatSessionAddress } from '../../src/index.js'
import type { ModelFrame, SessionMailbox } from '../../src/index.js'
import { agentFixture, clock } from './fixtures.js'
import { profile, runnerLimits } from '../context/fixtures.js'
import { createCommunicationService, messageCatalog, channelIds } from '../communication/fixtures.js'

function provider(id: string, action: (call: number) => { name: string; args: object } | null) {
  let calls = 0
  return new ScriptedModelProvider({ providerId: id, maxConcurrentExchanges: 1, streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    script: async function* (): AsyncGenerator<ModelFrame> {
      const next = action(calls++)
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'response' }
      if (next === null) {
        yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'done' }
      } else {
        yield { kind: 'block-start', index: 0, block: 'tool-call', name: next.name, callId: `call-${calls}` }
        yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(next.args) }
      }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: next === null ? 'stop' : 'tool-calls' }
    } })
}

it('routes request/reply through independent durable Inbox/Outbox facts and resumes the waiting root', async () => {
  let mailboxA: SessionMailbox; let mailboxB: SessionMailbox
  const aProvider = provider('requester', call => call === 0 ? { name: 'agent_send_message', args: { peerKey: 'reviewer', type: 'test/request', payloadVersion: 1, payloadJson: '{"text":"Review"}' } }
    : call === 1 ? { name: 'agent_await_reply', args: { messageId: mailboxA.snapshot().outbox[0]!.messageId, timeoutMs: 10000 } } : null)
  const bProvider = provider('reviewer', call => call === 0 ? { name: 'agent_reply_message', args: { messageId: mailboxB.snapshot().inbox[0]!.messageId, type: 'test/reply', payloadVersion: 1, payloadJson: '{"text":"Reviewed"}' } } : null)
  const messages = [{ type: 'test/request', payloadVersion: 1, requiresReply: true }, { type: 'test/reply', payloadVersion: 1, requiresReply: false }]
  const f = await agentFixture({ nativeActions: ['agent_send_message', 'agent_await_reply'], messages,
    peers: [{ key: 'reviewer', address: formatSessionAddress(parseSessionId('30000000-0000-4000-8000-000000000102')), channelId: parseChannelId(channelIds[0]) }] }, aProvider, messageCatalog)
  const { service, policy } = createCommunicationService()
  const peer = await f.repo.create()
  mailboxA = await service.attach(f.session, { catalog: messageCatalog, policy })
  mailboxB = await service.attach(peer, { catalog: messageCatalog, policy })
  const contextB = new SessionContext({ session: peer, messageCatalog })
  const profileB = await contextB.recordProfile(profile('generation', { rendererVersion: 'context-neutral/v2' }))
  await installAgentSpec(peer, { ...f.spec, label: 'reviewer', profileEventId: profileB.stored.eventId,
    nativeActions: ['agent_reply_message'], target: { ...f.spec.target, provider: bProvider.descriptor } }, clock)
  const a = new SessionAgent({ session: f.session, model: new SessionModelRunner({ session: f.session, provider: aProvider, limits: runnerLimits }),
    context: f.context, mailbox: mailboxA, dispatcher: service.createDispatcher(mailboxA), messageCatalog, clock })
  const b = new SessionAgent({ session: peer, model: new SessionModelRunner({ session: peer, provider: bProvider, limits: runnerLimits }),
    context: contextB, mailbox: mailboxB, dispatcher: service.createDispatcher(mailboxB), messageCatalog, clock })
  try {
    await a.submitInput({ kind: 'task', text: 'request review', originLabel: 'test' })
    expect((await a.start()).waits).toHaveLength(1)
    expect(mailboxB.snapshot().inbox).toHaveLength(1)
    expect((await b.start()).roots[0]?.outcome).toBe('completed')
    const result = await a.start()
    expect(result.roots).toHaveLength(1)
    expect(result.roots[0]).toMatchObject({ outcome: 'completed', budget: { models: 3, messages: 1, waits: 1 } })
    expect(mailboxA.snapshot().inbox[0]?.status).toBe('processed')
    expect(mailboxB.snapshot().inbox[0]?.status).toBe('processed')
  } finally { await a.dispose(); await b.dispose(); await service.dispose(); await bProvider.dispose(); await f.close() }
})

it('attaches its owned receiver only after Run admission and releases it on dispose', async () => {
  const f = await agentFixture({}, undefined, messageCatalog)
  const { service, policy, directory } = createCommunicationService()
  const agent = new SessionAgent({ session: f.session, model: new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits }),
    context: f.context, communication: { service, policy }, messageCatalog, clock })
  try {
    expect(directory.status(f.session.header.address).kind).not.toBe('online')
    const abort = new AbortController(); abort.abort()
    expect(() => agent.start({ signal: abort.signal })).toThrowError(expect.objectContaining({ code: 'AGENT_CANCELLED' }))
    expect(agent.snapshot().runs).toHaveLength(0)
    await agent.start()
    expect(directory.status(f.session.header.address).kind).toBe('online')
    await agent.dispose()
    expect(directory.status(f.session.header.address).kind).not.toBe('online')
    expect(f.session.status).toBe('open')
  } finally { await agent.dispose(); await service.dispose(); await f.close() }
})

it('a failed lazy attachment settles the Run before claiming an input', async () => {
  const f = await agentFixture({}, undefined, messageCatalog)
  const { service, policy } = createCommunicationService()
  const agent = new SessionAgent({ session: f.session, model: new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits }),
    context: f.context, communication: { service, policy }, messageCatalog, clock })
  try {
    await agent.submitInput({ kind: 'task', text: 'preserved task', originLabel: 'test' })
    await service.dispose()
    await expect(agent.start()).rejects.toMatchObject({ code: 'AGENT_COMMUNICATION_UNAVAILABLE' })
    expect(agent.snapshot().openRun).toBeNull()
    expect(agent.snapshot().inputs[0]?.status).toBe('queued')
    expect(agent.snapshot().turns).toHaveLength(0)
  } finally { await agent.dispose(); await f.close() }
})

it('direct commands spend only the Session command quota and do not drive models or delivery', async () => {
  const f = await agentFixture({ maxDirectSendCommandsPerSession: 1, messages: [{ type: 'test/request', payloadVersion: 1, requiresReply: false }],
    peers: [{ key: 'peer', address: formatSessionAddress(parseSessionId('30000000-0000-4000-8000-000000000102')), channelId: parseChannelId(channelIds[0]) }] }, undefined, messageCatalog)
  const { service, policy } = createCommunicationService()
  const mailbox = await service.attach(f.session, { catalog: messageCatalog, policy })
  const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  const agent = new SessionAgent({ session: f.session, model, context: f.context, mailbox, dispatcher: service.createDispatcher(mailbox), messageCatalog, clock })
  const command = { kind: 'send' as const, peerKey: 'peer', type: 'test/request', payloadVersion: 1, payloadJson: '{"text":"command"}' }
  try {
    const sending = agent.sendMessage(command)
    expect(() => agent.start()).toThrowError(expect.objectContaining({ code: 'AGENT_BUSY' }))
    await sending
    expect((await agent.sendMessage(command)).run?.settled?.payload.stoppedBy).toBe('command-budget')
    expect(agent.snapshot().commands).toHaveLength(1)
    expect(agent.snapshot().roots).toHaveLength(0)
    expect(model.snapshot().invocations).toHaveLength(0)
    expect(mailbox.snapshot().outbox).toHaveLength(1)
    expect(mailbox.snapshot().outbox[0]?.attemptCount).toBe(0)
    await expect(agent.endSession()).rejects.toMatchObject({ code: 'AGENT_BUSY' })
  } finally { await agent.dispose(); await service.dispose(); await f.close() }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { h, fixture, catalog, modelLimits, FaultBackend } from './helpers/tool-fixture.mjs'
import { verifyAgentPrefixes } from './helpers/agent-prefixes.mjs'
import { contextProfile } from '../examples/context-fixture.mjs'
import { agentSpec } from '../examples/agent-fixture.mjs'

const clock = { now: () => 1789257600000 }
const definitions = catalog([...h.contextSessionEventDefinitions, ...h.communicationSessionEventDefinitions, ...h.agentSessionEventDefinitions])
function provider(action) {
  let calls = 0
  return new h.ScriptedModelProvider({ providerId: 'prefixes', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 }, script: async function* () {
      const next = await action(calls++)
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'result' }
      if (next === null) { yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'done' } }
      else { yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'call', name: next.name }; yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(next.args) } }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: next === null ? 'stop' : 'tool-calls' }
    } })
}

test('all file prefixes: maintenance v2 deadline settlement and interrupted recovery', async () => fixture(async f => {
  let now = clock.now()
  const agent = await assemble(f, provider(() => ({ name: 'agent_ask_user', args: { question: 'continue?', timeoutMs: 1000 } })),
    { nativeActions: ['agent_ask_user'] }, { clock: { now: () => now } })
  try {
    await agent.submitInput({ kind: 'task', text: 'wait then expire', originLabel: 'maintenance-prefix' })
    await agent.start()
    now += 60_001
    await agent.maintain()
    assert.equal(agent.snapshot().runs.at(-1).started.stored.payloadVersion, 2)
    assert.equal(agent.snapshot().roots[0].outcome, 'timed-out')
    await verifyAgentPrefixes('maintenance-v2-expiry', f.session.snapshot())
  } finally { await agent.dispose() }
}, { catalog: definitions, clock }))
async function assemble(f, model, overrides = {}, extra = {}) {
  f.providers.push(model)
  const messages = extra.messageCatalog ?? h.createMessageCatalog()
  const context = new h.SessionContext({ session: f.session, messageCatalog: messages, toolRegistry: f.registry })
  const profile = await context.recordProfile(contextProfile('generation', { rendererVersion: 'context-neutral/v2', toolNames: overrides.toolNames ?? [] }))
  await h.installAgentSpec(f.session, agentSpec(profile.stored.eventId, model.descriptor, overrides), clock)
  return new h.SessionAgent({ session: f.session, model: new h.SessionModelRunner({ session: f.session, provider: model, limits: modelLimits }), context, tools: f.runner, messageCatalog: messages, clock, ...extra })
}

test('all file prefixes: ordinary Tool loop and successful Session end', async () => fixture(async f => {
  const agent = await assemble(f, provider(call => call === 0 ? { name: 'echo', args: { n: 1 } } : null), { toolNames: ['echo'] })
  try {
    await agent.submitInput({ kind: 'task', text: 'tool', originLabel: 'prefix' }); await agent.start(); await agent.endSession()
    await verifyAgentPrefixes('tool-and-end', f.session.snapshot())
  } finally { await agent.dispose() }
}, { catalog: definitions, clock }))

test('all file prefixes: user wait match, cancellation, and no duplicate continuation', async () => {
  let cancel; let agent
  const backend = new FaultBackend(new h.MemorySessionBackend({ maxRecordBytes: 262144 }), async () => {}, async event => {
    if (event.type === 'agent/wait-settled' && event.payload.outcome === 'matched') { agent.pause(); cancel = agent.cancel(agent.snapshot().roots[0].id) }
  })
  await fixture(async f => {
  agent = await assemble(f, provider(call => call === 0 ? { name: 'agent_ask_user', args: { question: 'continue?', timeoutMs: 1000 } } : null), { nativeActions: ['agent_ask_user'] })
  try {
    await agent.submitInput({ kind: 'task', text: 'ask', originLabel: 'prefix' }); const waiting = await agent.start()
    await agent.submitInput({ kind: 'answer', wait: waiting.waits[0].reference, text: 'yes', originLabel: 'prefix' })
    await agent.start(); await cancel
    assert.equal(agent.snapshot().waits[0].settled.payload.outcome, 'matched')
    assert.equal(agent.snapshot().inputs[1].status, 'not-adopted')
    assert.equal(agent.snapshot().turns.length, 1)
    await verifyAgentPrefixes('user-wait-cancel', f.session.snapshot())
  } finally { await agent.dispose() }
}, { catalog: definitions, clock, backend })
})

for (const cancelMatched of [false, true]) test('all file prefixes: early reply, receipt and command; cancel matched=' + cancelMatched, async () => {
  let agent; let cancel
  const backend = new FaultBackend(new h.MemorySessionBackend({ maxRecordBytes: 262144 }), async () => {}, async event => {
    if (cancelMatched && event.type === 'agent/wait-settled' && event.payload.outcome === 'matched') { agent.pause(); cancel = agent.cancel(agent.snapshot().roots[0].id) }
  })
  await fixture(async f => {
  const directory = h.createSessionDirectory()
  const service = new h.CommunicationService({ directory, transport: h.createInProcessMessageTransport(directory), clock,
    limits: { maxMessageBytes: 4096, maxPendingOutbox: 8, maxPendingInbox: 8, maxDeliveryAttempts: 3, maxAttemptsPerRun: 8, maxSendJournalConflicts: 4 } })
  const message = h.createMessageDefinition({ type: 'prefix/message', payloadVersion: 1, decode: value => value })
  const messageCatalog = h.createMessageCatalog([message]); const policy = h.allowAllCommunicationPolicy
  const peer = await f.repository.create()
  const local = await service.attach(f.session, { catalog: messageCatalog, policy }); const remote = await service.attach(peer, { catalog: messageCatalog, policy })
  const channelId = h.parseChannelId('20000000-0000-4000-8000-000000000101')
  agent = await assemble(f, provider(async call => {
    if (call === 0) return { name: 'agent_send_message', args: { peerKey: 'peer', type: message.type, payloadVersion: 1, payloadJson: '{"text":"question"}' } }
    if (call === 1) {
      await service.createDispatcher(local).dispatch()
      await remote.reply(remote.snapshot().inbox[0].messageId, message, { text: 'early' })
      await service.createDispatcher(remote).dispatch()
      return { name: 'agent_await_reply', args: { messageId: local.snapshot().outbox[0].messageId, timeoutMs: 1000 } }
    }
    return null
  }), { nativeActions: ['agent_send_message', 'agent_await_reply'], messages: [{ type: message.type, payloadVersion: 1, requiresReply: false }],
    peers: [{ key: 'peer', address: peer.header.address, channelId }], maxDirectSendCommandsPerSession: 1 }, { mailbox: local, messageCatalog })
  try {
    await agent.submitInput({ kind: 'task', text: 'request', originLabel: 'prefix' }); await agent.start(); await cancel
    if (cancelMatched) await agent.start()
    const result = agent.report()
    assert.equal(result.roots[0].outcome, cancelMatched ? 'cancelled' : 'completed'); assert.equal(local.snapshot().inbox[0].status, 'processed')
    const state = agent.snapshot(); assert.ok(state.inputs[1].sequence < state.waits[0].created.stored.sequence)
    await agent.sendMessage({ kind: 'send', peerKey: 'peer', type: message.type, payloadVersion: 1, payloadJson: '{"text":"direct"}' })
    assert.equal((await agent.sendMessage({ kind: 'send', peerKey: 'peer', type: message.type, payloadVersion: 1, payloadJson: '{"text":"direct"}' })).run.settled.payload.stoppedBy, 'command-budget')
    if (cancelMatched) { assert.equal(agent.snapshot().turns[1].started.payload.root, null); assert.equal(agent.snapshot().waits[0].settled.payload.outcome, 'matched') }
    await verifyAgentPrefixes(cancelMatched ? 'peer-match-cancel' : 'early-reply-receipt-command', f.session.snapshot())
  } finally { await agent.dispose(); await service.dispose(); await directory.dispose() }
}, { catalog: definitions, clock, backend })
})

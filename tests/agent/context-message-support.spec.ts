import { expect, it } from 'vitest'
import {
  SessionAgent, SessionContext, SessionModelRunner, ScriptedModelProvider, createMessageCatalog,
  createMessageDefinition, parseChannelId, projectContextSession, rebuildAssembly,
} from '../../src/index.js'
import type { MessageCatalog, ModelFrame } from '../../src/index.js'
import { agentFixture, clock } from './fixtures.js'
import { emptyMessageCatalog, runnerLimits, scriptedModel } from '../context/fixtures.js'
import { createCommunicationService, messageCatalog, requestMessage, channelIds } from '../communication/fixtures.js'

function questioningProvider() {
  let starts = 0
  const provider = new ScriptedModelProvider({ providerId: 'context-peer-question', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    script: async function* (): AsyncGenerator<ModelFrame> {
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'response' }
      if (starts++ === 0) {
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'question', name: 'agent_ask_user' }
        yield { kind: 'arguments-delta', index: 0, text: '{"question":"Which format?","timeoutMs":10000}' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } else {
        yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'report' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      }
    } })
  return { provider, starts: () => starts }
}

it.each(['removed', 'changed-decoder'] as const)('resumes a processed peer task with its Definition %s', async mode => {
  const { provider, starts } = questioningProvider()
  const f = await agentFixture({ nativeActions: ['agent_ask_user'], messages: [{ type: 'test/request', payloadVersion: 1, requiresReply: false }] }, provider, messageCatalog)
  const { service, policy } = createCommunicationService()
  const peer = await f.repo.create()
  const local = await service.attach(f.session, { catalog: messageCatalog, policy })
  const remote = await service.attach(peer, { catalog: messageCatalog, policy })
  let context = f.context
  let model = new SessionModelRunner({ session: f.session, provider, limits: runnerLimits })
  let agent = new SessionAgent({ session: f.session, model, context, mailbox: local, messageCatalog, clock })
  let currentDecodes = 0
  const replacement: MessageCatalog = mode === 'removed' ? emptyMessageCatalog : createMessageCatalog([
    createMessageDefinition({ type: requestMessage.type, payloadVersion: requestMessage.payloadVersion, decode: () => {
      currentDecodes++; throw new Error('processed input must not call a current decoder')
    } }),
  ])
  try {
    await remote.send(requestMessage, { kind: 'root', recipient: f.session.header.address, channelId: parseChannelId(channelIds[0]) }, { text: 'write peer report' })
    await service.createDispatcher(remote).dispatch()
    const waiting = await agent.start()
    expect(local.snapshot().inbox[0]?.status).toBe('processed')
    expect(starts()).toBe(1)
    await agent.dispose()
    context = new SessionContext({ session: f.session, messageCatalog: replacement })
    model = new SessionModelRunner({ session: f.session, provider, limits: runnerLimits })
    agent = new SessionAgent({ session: f.session, model, context, mailbox: local, messageCatalog: replacement, clock })
    await agent.submitInput({ kind: 'answer', wait: waiting.waits[0]!.reference, text: 'Markdown', originLabel: 'test' })
    expect((await agent.start()).roots[0]?.outcome).toBe('completed')
    expect(starts()).toBe(2)
    expect(currentDecodes).toBe(0)
    expect(JSON.stringify(model.snapshot().invocations.at(-1)!.prepared.payload.submission.request)).toContain('write peer report')
    const snapshot = f.session.snapshot()
    for (const item of projectContextSession(snapshot).assemblies) {
      expect(rebuildAssembly(snapshot, item.committed.stored.eventId)).toMatchObject({ kind: 'rebuilt', adoption: { kind: 'adopted' } })
    }
  } finally { await agent.dispose(); await service.dispose(); await f.close() }
})

it('requires current support for a newly claimed pending peer message', async () => {
  const counters = { prepare: 0, acquire: 0, start: 0 }
  const provider = scriptedModel('answer', counters)
  const f = await agentFixture({ messages: [{ type: 'test/request', payloadVersion: 1, requiresReply: false }] }, provider, messageCatalog)
  const { service, policy } = createCommunicationService(), peer = await f.repo.create()
  const local = await service.attach(f.session, { catalog: messageCatalog, policy })
  const remote = await service.attach(peer, { catalog: messageCatalog, policy })
  await f.context.dispose()
  const context = new SessionContext({ session: f.session, messageCatalog: emptyMessageCatalog })
  const agent = new SessionAgent({ session: f.session, model: new SessionModelRunner({ session: f.session, provider, limits: runnerLimits }), context, mailbox: local, messageCatalog, clock })
  try {
    await remote.send(requestMessage, { kind: 'root', recipient: f.session.header.address, channelId: parseChannelId(channelIds[0]) }, { text: 'new peer input' })
    await service.createDispatcher(remote).dispatch()
    expect((await agent.start()).roots[0]).toMatchObject({ outcome: 'failed', reason: 'context-blocked:unsupported-message' })
    expect(counters).toEqual({ prepare: 0, acquire: 0, start: 0 })
    expect(projectContextSession(f.session.snapshot()).assemblies).toHaveLength(0)
  } finally { await agent.dispose(); await service.dispose(); await f.close() }
})

it('defers an unsupported pending peer body while adopting an independent user input', async () => {
  const f = await agentFixture({ messages: [{ type: 'test/request', payloadVersion: 1, requiresReply: false }] }, undefined, messageCatalog)
  const { service, policy } = createCommunicationService(), peer = await f.repo.create()
  const local = await service.attach(f.session, { catalog: messageCatalog, policy })
  const remote = await service.attach(peer, { catalog: messageCatalog, policy })
  await f.context.dispose()
  const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  const agent = new SessionAgent({ session: f.session, model, context: new SessionContext({ session: f.session, messageCatalog: emptyMessageCatalog }), mailbox: local, messageCatalog: emptyMessageCatalog, clock })
  try {
    await remote.send(requestMessage, { kind: 'root', recipient: f.session.header.address, channelId: parseChannelId(channelIds[0]) }, { text: 'deferred peer secret' })
    await service.createDispatcher(remote).dispatch()
    await agent.submitInput({ kind: 'task', text: 'independent user task', originLabel: 'test' })
    expect((await agent.start()).roots[0]?.outcome).toBe('completed')
    const request = JSON.stringify(model.snapshot().invocations[0]!.prepared.payload.submission.request)
    expect(request).toContain('independent user task')
    expect(request).not.toContain('deferred peer secret')
    expect(local.snapshot().inbox[0]?.status).toBe('pending')
    const assembly = projectContextSession(f.session.snapshot()).assemblies[0]!
    expect(assembly.committed.payload.deferred).toHaveLength(1)
    expect(rebuildAssembly(f.session.snapshot(), assembly.committed.stored.eventId).kind).toBe('rebuilt')
  } finally { await agent.dispose(); await service.dispose(); await f.close() }
})

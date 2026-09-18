import { expect, it } from 'vitest'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { SessionAgent } from '../../src/agent/session-agent.js'
import { agentFixture, clock } from './fixtures.js'
import { emptyMessageCatalog, runnerLimits } from '../context/fixtures.js'
import { rebuildAssembly } from '../../src/context/projection.js'
import { agentWaitSettledEvent } from '../../src/agent/session-events.js'

function questioningProvider() {
  let calls = 0
  return new ScriptedModelProvider({ providerId: 'questioner', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    script: async function* (): AsyncGenerator<ModelFrame> {
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'response' }
      if (calls++ === 0) {
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'question', name: 'agent_ask_user' }
        yield { kind: 'arguments-delta', index: 0, text: '{"question":"Which format?","timeoutMs":10000}' }
        yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: 'tool-calls' }
      } else {
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: 'Answer in the requested format.' }
        yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: 'stop' }
      }
    } })
}
it('closes a waiting turn and resumes with one causal answer and the original root budget', async () => {
  const f = await agentFixture({ nativeActions: ['agent_ask_user'] }, questioningProvider())
  const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  const agent = new SessionAgent({ session: f.session, model, context: f.context, messageCatalog: emptyMessageCatalog, clock })
  try {
    await agent.submitInput({ kind: 'task', text: 'Write a report', originLabel: 'test' })
    const waiting = await agent.start()
    expect(waiting.waits).toHaveLength(1)
    expect(waiting.openTurn).toBeNull()
    const wait = waiting.waits[0]!
    await agent.submitInput({ kind: 'answer', wait: wait.reference, text: 'Markdown please', originLabel: 'test' })
    const finished = await agent.start()
    expect(finished.roots).toHaveLength(1)
    expect(finished.roots[0]).toMatchObject({ outcome: 'completed', budget: { models: 2, waits: 1 } })
    const request = model.snapshot().invocations.at(-1)!.prepared.payload.submission.request
    expect(JSON.stringify(request).match(/Markdown please/g)).toHaveLength(1)
    expect(request.messages.map(message => message.role)).toEqual(['user', 'user', 'assistant', 'user', 'user'])
    for (const event of f.session.snapshot().history.at(-1)!.events.filter(event => event.stored.type === 'context/assembly-committed')) {
      expect(rebuildAssembly(f.session.snapshot(), event.stored.eventId).kind).toBe('rebuilt')
    }
  } finally { await agent.dispose(); await f.close() }
})

it('cancels a root after its Run closed at a durable wait', async () => {
  const f = await agentFixture({ nativeActions: ['agent_ask_user'] }, questioningProvider())
  const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  const agent = new SessionAgent({ session: f.session, model, context: f.context, messageCatalog: emptyMessageCatalog, clock })
  try {
    await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'test' })
    const waiting = await agent.start()
    const result = await agent.cancel(waiting.roots[0]!.id)
    expect(result.roots[0]?.outcome).toBe('cancelled')
    expect(result.waits).toHaveLength(0)
    await expect(agent.submitInput({ kind: 'answer', wait: waiting.waits[0]!.reference, text: 'late', originLabel: 'test' })).rejects.toMatchObject({ code: 'AGENT_STATE_INVALID' })
    expect(model.snapshot().invocations).toHaveLength(1)
  } finally { await agent.dispose(); await f.close() }
})

it('does not adopt a user answer reserved before the root was cancelled', async () => {
  const f = await agentFixture({ nativeActions: ['agent_ask_user'] }, questioningProvider())
  const agent = new SessionAgent({ session: f.session, model: new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits }), context: f.context, messageCatalog: emptyMessageCatalog, clock })
  try {
    await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'test' })
    const waiting = await agent.start(); const wait = waiting.waits[0]!
    const answer = await agent.submitInput({ kind: 'answer', wait: wait.reference, text: 'answer', originLabel: 'test' })
    await f.journal.append(agentWaitSettledEvent, () => ({ wait: wait.reference, outcome: 'matched' as const, response: { kind: 'user' as const, eventId: answer.stored.eventId },
      reason: 'response-matched', observedAt: new Date(clock.now()).toISOString(), supportedMessages: [], outboxTerminal: null }))
    const result = await agent.cancel(waiting.roots[0]!.id)
    expect(result.inputs.at(-1)?.status).toBe('not-adopted')
    expect(agent.snapshot().waits[0]?.settled?.payload.outcome).toBe('matched')
    expect((await agent.start()).roots).toHaveLength(1)
  } finally { await agent.dispose(); await f.close() }
})

it('adopts an on-time answer even when the next wake occurs after the wait deadline', async () => {
  const f = await agentFixture({ nativeActions: ['agent_ask_user'] }, questioningProvider())
  let now = clock.now()
  const agent = new SessionAgent({ session: f.session, model: new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits }), context: f.context, messageCatalog: emptyMessageCatalog, clock: { now: () => now } })
  try {
    await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'test' })
    const waiting = await agent.start()
    await agent.submitInput({ kind: 'answer', wait: waiting.waits[0]!.reference, text: 'on time', originLabel: 'test' })
    now += 15000
    const result = await agent.start()
    expect(result.roots[0]?.outcome).toBe('completed')
  } finally { await agent.dispose(); await f.close() }
})

it('expires the root rather than granting a fresh budget to an on-time reserved answer', async () => {
  const f = await agentFixture({ nativeActions: ['agent_ask_user'] }, questioningProvider())
  let now = clock.now()
  const agent = new SessionAgent({ session: f.session, model: new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits }), context: f.context, messageCatalog: emptyMessageCatalog, clock: { now: () => now } })
  try {
    await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'test' })
    const waiting = await agent.start()
    await agent.submitInput({ kind: 'answer', wait: waiting.waits[0]!.reference, text: 'on time', originLabel: 'test' })
    now += 60000
    const result = await agent.start()
    expect(result.roots[0]).toMatchObject({ outcome: 'timed-out', budget: { models: 1 } })
    expect(result.inputs.at(-1)?.status).toBe('not-adopted')
  } finally { await agent.dispose(); await f.close() }
})

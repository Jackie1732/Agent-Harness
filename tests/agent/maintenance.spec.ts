import { expect, it } from 'vitest'
import type { ModelFrame } from '../../src/model/contract.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { SessionAgent } from '../../src/agent/session-agent.js'
import { agentFixture, clock } from './fixtures.js'
import { emptyMessageCatalog, runnerLimits } from '../context/fixtures.js'

function waitProvider(counter: { calls: number }) {
  return new ScriptedModelProvider({ providerId: 'maintenance-wait', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    script: async function* (): AsyncGenerator<ModelFrame> {
      counter.calls += 1
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'wait' }
      yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'question', name: 'agent_ask_user' }
      yield { kind: 'arguments-delta', index: 0, text: '{"question":"continue?","timeoutMs":1000}' }
      yield { kind: 'block-end', index: 0 }
      yield { kind: 'complete', stopReason: 'tool-calls' }
    },
  })
}

it('observes readiness without writes and settles due work in a v2 maintenance Run', async () => {
  const counter = { calls: 0 }
  let now = clock.now()
  const f = await agentFixture({ nativeActions: ['agent_ask_user'] }, waitProvider(counter))
  const agent = new SessionAgent({ session: f.session,
    model: new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits }),
    context: f.context, messageCatalog: emptyMessageCatalog, clock: { now: () => now } })
  try {
    await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'maintenance-test' })
    const position = f.session.snapshot().localPosition
    expect(agent.readiness()).toMatchObject({ canRun: true, canMaintain: false })
    expect(f.session.snapshot().localPosition).toBe(position)
    const waiting = await agent.start()
    expect(waiting.waits).toHaveLength(1)
    now += 2000
    expect(agent.readiness()).toMatchObject({ canRun: false, canMaintain: true })
    const maintained = await agent.maintain()
    expect(maintained.roots[0]?.outcome).toBe('timed-out')
    expect(counter.calls).toBe(1)
    const runs = f.session.snapshot().history.at(-1)!.events.filter(event => event.stored.type === 'agent/run-started')
    expect(runs.at(-1)?.stored.payloadVersion).toBe(2)
  } finally { await agent.dispose(); await f.close() }
})

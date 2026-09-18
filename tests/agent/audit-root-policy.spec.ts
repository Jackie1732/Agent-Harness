import { expect, it } from 'vitest'
import type { ModelFrame } from '../../src/index.js'
import { SessionContext } from '../../src/index.js'
import { agentFixture, clock } from './fixtures.js'
import { auditedAgent, auditProvider, finalFrames, createDeferred } from './audit-fixtures.js'
import { emptyMessageCatalog } from '../context/fixtures.js'

for (const actions of [false, true]) it('expires a root when model settlement crosses its deadline; actions=' + actions, async () => {
  let now = clock.now(); let calls = 0
  const provider = auditProvider({ script: async function* (): AsyncGenerator<ModelFrame> {
    calls++; now += 60001
    if (!actions) { yield* finalFrames(); return }
    yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'late' }
    yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'question', name: 'agent_ask_user' }
    yield { kind: 'arguments-delta', index: 0, text: '{"question":"too late?","timeoutMs":1000}' }
    yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
  } })
  const f = await agentFixture({ nativeActions: ['agent_ask_user'] }, provider); const agent = auditedAgent(f, { clock: { now: () => now } })
  try {
    await agent.submitInput({ kind: 'task', text: 'deadline', originLabel: 'audit' })
    const report = await agent.start(); expect(calls).toBe(1)
    expect(report.roots[0]?.outcome).toBe('timed-out'); expect(report.pendingControls).toEqual([]); expect(report.final).toBeNull()
    expect(agent.snapshot().waits).toEqual([])
    expect(agent.snapshot().controls[0]?.requested.payload.kind).toBe('expire-work')
    if (actions) expect(agent.snapshot().actions[0]?.payload.result.kind).toBe('not-started')
  } finally { await agent.dispose(); await f.close() }
})

for (const strict of [false, true]) for (const partial of [false, true]) it('checks root usage across a wait and a replacement Agent; strict=' + strict + ', partial=' + partial, async () => {
  let calls = 0
  const provider = auditProvider({ script: async function* (): AsyncGenerator<ModelFrame> {
    if (calls++ > 0) { yield* finalFrames(); return }
    yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'ask' }
    yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'question', name: 'agent_ask_user' }
    yield { kind: 'arguments-delta', index: 0, text: '{"question":"continue?","timeoutMs":1000}' }
    yield { kind: 'block-end', index: 0 }
    if (partial) yield { kind: 'usage', counts: { inputTokens: 10 } }
    yield { kind: 'complete', stopReason: 'tool-calls' }
  } })
  const f = await agentFixture({ nativeActions: ['agent_ask_user'], usagePolicy: strict ? 'stop-on-unknown' : 'observe-only' }, provider)
  const first = auditedAgent(f); let next: ReturnType<typeof auditedAgent> | undefined
  try {
    await first.submitInput({ kind: 'task', text: 'task', originLabel: 'audit' }); const report = await first.start()
    expect(report.waits).toHaveLength(1); await first.dispose()
    next = auditedAgent(f, { context: new SessionContext({ session: f.session, messageCatalog: emptyMessageCatalog }) })
    await next.submitInput({ kind: 'answer', wait: report.waits[0]!.reference, text: 'yes', originLabel: 'audit' })
    const finished = await next.start()
    expect(calls).toBe(strict ? 1 : 2); expect(finished.roots[0]?.outcome).toBe(strict ? 'failed' : 'completed')
    expect(finished.roots[0]?.budget.waits).toBe(1)
    if (strict) expect(finished.roots[0]?.reason).toBe('model-usage-unknown')
  } finally { await first.dispose(); await next?.dispose(); await f.close() }
})

it('a cancellation committed before final settlement wins without leaving an orphan control', async () => {
  const entered = createDeferred<void>(); const release = createDeferred<void>()
  const f = await agentFixture({}, auditProvider({ onClose: async () => { entered.resolve(); await release.promise } }))
  const owner = auditedAgent(f); const controller = auditedAgent(f, { context: new SessionContext({ session: f.session, messageCatalog: emptyMessageCatalog }) })
  try {
    await owner.submitInput({ kind: 'task', text: 'task', originLabel: 'audit' }); const run = owner.start(); await entered.promise
    await controller.cancel(owner.snapshot().roots[0]!.id); release.resolve()
    const result = await run; expect(result.roots[0]?.outcome).toBe('cancelled'); expect(result.pendingControls).toEqual([])
    const position = f.session.snapshot().localPosition; await controller.cancel(result.roots[0]!.id)
    expect(f.session.snapshot().localPosition).toBe(position)
  } finally { release.resolve(); await owner.dispose(); await controller.dispose(); await f.close() }
})

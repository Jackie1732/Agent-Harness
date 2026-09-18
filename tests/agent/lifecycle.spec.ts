import { expect, it } from 'vitest'
import { SessionAgent, SessionContext, SessionModelRunner, ScriptedModelProvider } from '../../src/index.js'
import type { ModelFrame } from '../../src/index.js'
import { agentFixture, clock } from './fixtures.js'
import { emptyMessageCatalog, runnerLimits } from '../context/fixtures.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
function heldProvider() {
  const entered = deferred(); const release = deferred()
  let issued = 0; let closed = 0
  const provider = new ScriptedModelProvider({ providerId: 'held', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    onClose: () => { closed++ }, script: async function* (): AsyncGenerator<ModelFrame> {
      issued++; entered.resolve(); await release.promise
      yield { kind: 'message-start', responseId: 'held', reportedModel: 'fixture-model' }
      yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'done' }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
    } })
  return { provider, entered, release, counts: () => ({ issued, closed }) }
}
function runtime(f: Awaited<ReturnType<typeof agentFixture>>, context = f.context) {
  return new SessionAgent({ session: f.session, context, model: new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits }), messageCatalog: emptyMessageCatalog, clock })
}

it('allows exactly one durable owner when independent Agent objects race to start', async () => {
  const held = heldProvider(); const f = await agentFixture({}, held.provider)
  const a = runtime(f); const b = runtime(f, new SessionContext({ session: f.session, messageCatalog: emptyMessageCatalog }))
  try {
    await a.submitInput({ kind: 'task', text: 'task', originLabel: 'test' })
    const first = a.start(); const rejected = expect(b.start()).rejects.toMatchObject({ code: 'AGENT_STATE_INVALID' })
    await held.entered.promise; await rejected
    expect(held.counts().issued).toBe(1)
    held.release.resolve(); await first
    expect(a.snapshot().runs).toHaveLength(1)
  } finally { held.release.resolve(); await a.dispose(); await b.dispose(); await f.close() }
})

it('pause lets the current Turn settle but leaves the next input queued', async () => {
  const held = heldProvider(); const f = await agentFixture({}, held.provider); const agent = runtime(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'first', originLabel: 'test' })
    const run = agent.start(); await held.entered.promise
    await agent.submitInput({ kind: 'task', text: 'later', originLabel: 'test' })
    agent.pause(); held.release.resolve(); const report = await run
    expect(report.run?.settled?.payload.stoppedBy).toBe('paused')
    expect(report.inputs.map(item => item.status)).toEqual(['handled', 'queued'])
    expect(held.counts()).toEqual({ issued: 1, closed: 1 })
  } finally { held.release.resolve(); await agent.dispose(); await f.close() }
})

it('cancel persists its request while an uncooperative provider remains owned until real release', async () => {
  const held = heldProvider(); const f = await agentFixture({}, held.provider); const agent = runtime(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'test' })
    const run = agent.start(); await held.entered.promise
    const root = agent.snapshot().roots[0]!
    await agent.cancel(root.id)
    expect(agent.snapshot().openTurn).not.toBeNull()
    expect(held.counts().closed).toBe(0)
    held.release.resolve(); const report = await run
    expect(report.roots[0]?.outcome).toBe('cancelled')
    expect(report.inputs[0]?.status).toBe('review-required')
    expect(held.counts()).toEqual({ issued: 1, closed: 1 })
  } finally { held.release.resolve(); await agent.dispose(); await f.close() }
})

it('dispose shares its settlement and does not claim provider cleanup while generation is held', async () => {
  const held = heldProvider(); const f = await agentFixture({}, held.provider); const agent = runtime(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'test' })
    const run = agent.start(); await held.entered.promise
    const disposing = agent.dispose(); expect(agent.dispose()).toBe(disposing)
    expect(agent.status).toBe('disposing'); expect(held.counts().closed).toBe(0)
    held.release.resolve(); await run; await disposing
    expect(agent.status).toBe('disposed'); expect(f.session.snapshot().lifecycle).toBe('active')
  } finally { held.release.resolve(); await agent.dispose(); await f.close() }
})

it('rejects reentrant wait from a provider callback without deadlocking the owning Run', async () => {
  let agent: SessionAgent
  const provider = new ScriptedModelProvider({ providerId: 'reentrant', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    onPrepare: () => { expect(() => agent.wait()).toThrowError(expect.objectContaining({ code: 'AGENT_REENTRANT_WAIT' })) },
    script: async function* (): AsyncGenerator<ModelFrame> {
      yield { kind: 'message-start', responseId: 'test', reportedModel: 'fixture-model' }
      yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'done' }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
    } })
  const f = await agentFixture({}, provider); agent = runtime(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'test' })
    expect((await agent.start()).roots[0]?.outcome).toBe('completed')
  } finally { await agent.dispose(); await f.close() }
})

it('end joins the current Turn and rejects new input before writing the terminal Session event', async () => {
  const held = heldProvider(); const f = await agentFixture({}, held.provider); const agent = runtime(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'last task', originLabel: 'test' })
    const run = agent.start(); await held.entered.promise
    const ending = agent.endSession()
    expect(agent.endSession()).toBe(ending)
    expect(() => agent.submitInput({ kind: 'task', text: 'too late', originLabel: 'test' })).toThrowError(expect.objectContaining({ code: 'AGENT_INACTIVE' }))
    expect(f.session.snapshot().lifecycle).toBe('active')
    held.release.resolve(); await run; await ending
    expect(f.session.snapshot().history.at(-1)?.events.at(-1)?.stored.type).toBe('session/ended')
    expect(agent.snapshot().openRun).toBeNull()
  } finally { held.release.resolve(); await agent.dispose(); await f.close() }
})

it('a refused end preserves queued work and restores admission', async () => {
  const f = await agentFixture(); const agent = runtime(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'pending task', originLabel: 'test' })
    await expect(agent.endSession()).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    expect(agent.snapshot().closing).toBeNull()
    expect((await agent.start()).roots[0]?.outcome).toBe('completed')
  } finally { await agent.dispose(); await f.close() }
})

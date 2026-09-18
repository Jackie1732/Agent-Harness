import { expect, it } from 'vitest'
import { CapabilityRegistry, SessionContext, SessionAgentKey, createSessionAgentComponent } from '../../src/index.js'
import { agentFixture, clock } from './fixtures.js'
import { auditedAgent, auditProvider, finalFrames, createDeferred, interceptedBackend } from './audit-fixtures.js'
import { emptyMessageCatalog, runnerLimits } from '../context/fixtures.js'
import { SessionModelRunner } from '../../src/index.js'

it('stops the Run after real model cleanup failure without claiming the second input', async () => {
  let issued = 0
  const provider = auditProvider({ onClose: () => { throw new Error('release failed') }, script: async function* () { issued++; yield* finalFrames() } })
  const f = await agentFixture({}, provider); const agent = auditedAgent(f)
  try {
    for (const text of ['first', 'second']) await agent.submitInput({ kind: 'task', text, originLabel: 'audit' })
    const report = await agent.start()
    expect(issued).toBe(1); expect(report.inputs.map(input => input.status)).toEqual(['review-required', 'queued'])
    expect(report.roots[0]?.outcome).toBe('result-unknown'); expect(report.run?.settled?.payload.stoppedBy).toBe('faulted')
    expect(agent.status).toBe('faulted'); expect(agent.failure?.code).toBe('AGENT_CLEANUP_FAILED')
  } finally { await agent.dispose().catch(() => undefined); await f.close().catch(() => undefined) }
})

for (const unknown of [false, true]) it('signals cancellation before a blocked control append; unknown=' + unknown, async () => {
  const entered = createDeferred<void>(); const release = createDeferred<void>(); const writeEntered = createDeferred<void>(); const writeRelease = createDeferred<void>()
  let signal: AbortSignal | undefined
  const provider = auditProvider({ script: async function* (_request, current) { signal = current; entered.resolve(); await release.promise; yield* finalFrames() } })
  const backend = interceptedBackend(async event => { if (event.type === 'agent/control-requested') { writeEntered.resolve(); await writeRelease.promise } }, async event => {
    if (unknown && event.type === 'agent/control-requested') throw new Error('lost acknowledgement')
  })
  const f = await agentFixture({}, provider, emptyMessageCatalog, backend); const agent = auditedAgent(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'audit' })
    const run = agent.start(); const observed = run.catch(error => error); await entered.promise
    const cancel = agent.cancel(agent.snapshot().roots[0]!.id); const observedCancel = cancel.catch(error => error)
    expect(signal?.aborted).toBe(true); await writeEntered.promise
    expect(agent.snapshot().roots[0]?.stopControl).toBeNull()
    writeRelease.resolve(); await observedCancel; release.resolve(); await observed
    if (unknown) expect(agent.status).toBe('faulted')
    else { expect(agent.report().roots[0]?.outcome).toBe('cancelled'); expect(agent.report().pendingControls).toEqual([]) }
  } finally { writeRelease.resolve(); release.resolve(); await agent.dispose().catch(() => undefined); await f.close().catch(() => undefined) }
})

it('rejects start self-join and requests disposal before rejecting its reentrant wait', async () => {
  let agent: ReturnType<typeof auditedAgent>; let signal: AbortSignal | undefined
  const provider = auditProvider({ script: async function* (_request, current) {
    signal = current
    expect(() => agent.start()).toThrowError(expect.objectContaining({ code: 'AGENT_REENTRANT_WAIT' }))
    expect(() => agent.dispose()).toThrowError(expect.objectContaining({ code: 'AGENT_REENTRANT_WAIT' }))
    expect(agent.status).toBe('disposing'); expect(signal.aborted).toBe(true)
    yield* finalFrames()
  } })
  const f = await agentFixture({}, provider); agent = auditedAgent(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'audit' }); await agent.start()
    const cleanup = agent.dispose(); expect(agent.dispose()).toBe(cleanup); await cleanup
    expect(agent.status).toBe('disposed'); expect(f.session.status).toBe('open')
  } finally { await agent.dispose(); await f.close() }
})

it('guards inherited A to B to A task joins', async () => {
  let a: ReturnType<typeof auditedAgent>; let b: ReturnType<typeof auditedAgent>
  const bf = await agentFixture({}, auditProvider({ script: async function* () {
    expect(() => a.wait()).toThrowError(expect.objectContaining({ code: 'AGENT_REENTRANT_WAIT' })); yield* finalFrames()
  } })); b = auditedAgent(bf)
  const af = await agentFixture({}, auditProvider({ script: async function* () { await b.start(); yield* finalFrames() } })); a = auditedAgent(af)
  try {
    await a.submitInput({ kind: 'task', text: 'a', originLabel: 'audit' }); await b.submitInput({ kind: 'task', text: 'b', originLabel: 'audit' })
    expect((await a.start()).roots[0]?.outcome).toBe('completed')
  } finally { await a.dispose(); await b.dispose(); await af.close(); await bf.close() }
})

for (const fail of [false, true]) it('gates a leaked scoped Agent during staging and withdrawal; fail=' + fail, async () => {
  const f = await agentFixture(); const registry = new CapabilityRegistry(); const entered = createDeferred<void>(); const release = createDeferred<void>()
  let agent: ReturnType<typeof auditedAgent> | undefined
  const mounted = registry.mount({ label: 'scoped agent', requires: [], provides: [], setup: async context => {
    agent = await context.apply('agent', () => auditedAgent(f, { scope: context.scope }), resource => resource.dispose())
    entered.resolve(); await release.promise; if (fail) throw new Error('setup failure')
  } })
  try {
    await entered.promise
    expect(() => agent!.submitInput({ kind: 'task', text: 'early', originLabel: 'audit' })).toThrowError(expect.objectContaining({ code: 'AGENT_INACTIVE' }))
    expect(() => agent!.start()).toThrowError(expect.objectContaining({ code: 'AGENT_INACTIVE' }))
    expect(() => agent!.sendMessage({ kind: 'send', peerKey: 'peer', type: 'x', payloadVersion: 1, payloadJson: '{}' })).toThrowError(expect.objectContaining({ code: 'AGENT_INACTIVE' }))
    release.resolve(); await registry.whenQuiescent()
    if (!fail) { await agent!.submitInput({ kind: 'task', text: 'published', originLabel: 'audit' }); expect((await agent!.start()).roots[0]?.outcome).toBe('completed') }
    await mounted.dispose(); await registry.whenQuiescent()
    expect(() => agent!.start()).toThrowError(expect.objectContaining({ code: 'AGENT_INACTIVE' }))
    expect(f.session.status).toBe('open')
  } finally { release.resolve(); await registry.dispose(); await f.close() }
})

it('component factory owns construction and the published capability is withdrawn on disposal', async () => {
  const f = await agentFixture(); const registry = new CapabilityRegistry(); let agent: ReturnType<typeof auditedAgent> | undefined
  const mounted = registry.mount(createSessionAgentComponent({ label: 'agent', requires: [], create: () => ({ session: f.session,
    context: new SessionContext({ session: f.session, messageCatalog: emptyMessageCatalog }), model: new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits }), messageCatalog: emptyMessageCatalog, clock }) }))
  registry.mount({ label: 'consumer', requires: [SessionAgentKey], provides: [], setup: context => { agent = context.require(SessionAgentKey) } })
  try {
    await registry.whenQuiescent(); expect(agent).toBeDefined()
    await agent!.submitInput({ kind: 'task', text: 'published', originLabel: 'audit' }); await agent!.start()
    await mounted.dispose(); expect(() => agent!.start()).toThrowError(expect.objectContaining({ code: 'AGENT_INACTIVE' }))
  } finally { await registry.dispose(); await f.close() }
})


it('withdraws Scope admission and signals the active call before waiting for resource release', async () => {
  const entered = createDeferred<void>(); const release = createDeferred<void>(); let signal: AbortSignal | undefined
  const f = await agentFixture({}, auditProvider({ script: async function* (_request, current) { signal = current; entered.resolve(); await release.promise; yield* finalFrames() } }))
  const registry = new CapabilityRegistry(); let agent: ReturnType<typeof auditedAgent> | undefined
  const mounted = registry.mount(createSessionAgentComponent({ label: 'agent', requires: [], create: () => ({ session: f.session, context: f.context,
    model: new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits }), messageCatalog: emptyMessageCatalog, clock }) }))
  registry.mount({ label: 'reader', requires: [SessionAgentKey], provides: [], setup: context => { agent = context.require(SessionAgentKey) } })
  try {
    await registry.whenQuiescent(); await agent!.submitInput({ kind: 'task', text: 'held', originLabel: 'audit' })
    const run = agent!.start(); await entered.promise
    const disposal = mounted.dispose(); let done = false; void disposal.then(() => { done = true })
    expect(signal?.aborted).toBe(true); expect(done).toBe(false); expect(f.session.status).toBe('open')
    expect(() => agent!.start()).toThrowError(expect.objectContaining({ code: 'AGENT_INACTIVE' }))
    release.resolve(); await run; await disposal; expect(agent!.status).toBe('disposed')
  } finally { release.resolve(); await registry.dispose(); await f.close() }
})

it('does not mistake a retired task token for the next Run', async () => {
  const later = createDeferred<void>(); const observed = createDeferred<void>(); const held = createDeferred<void>(); const entered = createDeferred<void>()
  let agent: ReturnType<typeof auditedAgent>; let calls = 0
  const provider = auditProvider({ script: async function* () {
    if (calls++ === 0) void later.promise.then(() => { expect(() => agent.wait()).not.toThrow(); observed.resolve() })
    else { entered.resolve(); await held.promise }
    yield* finalFrames()
  } })
  const f = await agentFixture({}, provider); agent = auditedAgent(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'first', originLabel: 'audit' }); await agent.start()
    await agent.submitInput({ kind: 'task', text: 'second', originLabel: 'audit' }); const run = agent.start(); await entered.promise
    later.resolve(); await observed.promise; held.resolve(); await run
  } finally { later.resolve(); held.resolve(); await agent.dispose(); await f.close() }
})


it('releases newly constructed runners when component assembly fails before publication', async () => {
  const f = await agentFixture(); const peer = await f.repo.create(); const registry = new CapabilityRegistry()
  const context = new SessionContext({ session: peer, messageCatalog: emptyMessageCatalog })
  const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  registry.mount(createSessionAgentComponent({ label: 'invalid agent', requires: [], create: () => ({ session: f.session, context, model, messageCatalog: emptyMessageCatalog, clock }) }))
  try {
    await registry.whenQuiescent(); expect(model.status).toBe('disposed'); expect(context.status).toBe('disposed')
    expect(f.session.status).toBe('open'); expect(peer.status).toBe('open')
  } finally { await registry.dispose(); await f.close() }
})

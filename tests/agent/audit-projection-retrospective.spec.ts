import { expect, it } from 'vitest'
import { SessionModelRunner } from '../../src/model/runner.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { recoverAgentSession } from '../../src/agent/recovery.js'
import { inspectAgentReadiness } from '../../src/agent/readiness.js'
import { agentControlRequestedEvent, agentInputAbandonRequestedEvent, agentStepDecidedEvent } from '../../src/agent/session-events.js'
import { agentTurnSettledEvent } from '../../src/agent/session-events.js'
import { parseChannelId } from '../../src/communication/ids.js'
import { emptyAgentBudget } from '../../src/agent/budget.js'
import { classifyAgentModel } from '../../src/agent/decision.js'
import { emptyMessageCatalog, runnerLimits } from '../context/fixtures.js'
import { agentFixture, clock, observedAt, openStep } from './fixtures.js'
import { auditedAgent, auditProvider, finalFrames } from './audit-fixtures.js'
import { channelIds, createCommunicationService, messageCatalog, requestMessage } from '../communication/fixtures.js'

for (const decided of [false, true]) for (const expired of [false, true]) it('observes the unfinished final turn deadline during recovery; decision committed=' + decided + ', expired=' + expired, async () => {
  let calls = 0
  const f = await agentFixture({}, auditProvider({ script: async function* () { calls++; yield* finalFrames() } }))
  const runner = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  try {
    const opened = await openStep(f)
    const assembly = await f.context.assembleAgent(opened.consumer)
    expect(assembly.kind).toBe('ready')
    if (assembly.kind !== 'ready') throw new Error('assembly unavailable')
    const settled = await runner.invoke(assembly.request, { inputPrecondition: assembly.inputPrecondition })
    if (decided) await f.journal.append(agentStepDecidedEvent, () => ({ step: opened.step.stored.eventId,
      model: { invocationId: settled.payload.invocationId, assembly: assembly.committed.stored.eventId, settled: settled.stored.eventId },
      ...classifyAgentModel(settled.payload, f.spec, []), admitted: false, reservation: emptyAgentBudget,
      reassemblies: 0, observedAt }))
    await runner.dispose()
    const before = f.session.snapshot()
    const recovered = await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null,
      maxRecoveryWrites: 10, maxJournalConflicts: 4, clock: { now: () => clock.now() + (expired ? 60_001 : 0) } })
    expect(recovered.kind).toBe('recovered')
    expect(recovered.report.roots[0]).toMatchObject({ outcome: expired ? 'timed-out' : 'completed', budget: { models: 1, steps: 1 } })
    expect(recovered.report.inputs[0]?.status).toBe(expired ? 'review-required' : 'handled')
    if (expired) expect(recovered.report.final).toBeNull()
    else expect(recovered.report.final?.text).toBe('done')
    expect(calls).toBe(1)
    expect(f.session.snapshot().history.at(-1)!.events.slice(0, before.localPosition)).toEqual(before.history.at(-1)!.events)
    expect(projectAgentSession(f.session.snapshot()).openRun).toBeNull()
  } finally { await runner.dispose(); await f.close() }
})

it('keeps an already committed completed turn when only its Run needs recovery after the deadline', async () => {
  const f = await agentFixture({}, auditProvider())
  const runner = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  try {
    const opened = await openStep(f)
    const assembly = await f.context.assembleAgent(opened.consumer)
    if (assembly.kind !== 'ready') throw new Error('assembly unavailable')
    const settled = await runner.invoke(assembly.request, { inputPrecondition: assembly.inputPrecondition })
    await f.journal.append(agentStepDecidedEvent, () => ({ step: opened.step.stored.eventId,
      model: { invocationId: settled.payload.invocationId, assembly: assembly.committed.stored.eventId, settled: settled.stored.eventId },
      ...classifyAgentModel(settled.payload, f.spec, []), admitted: false, reservation: emptyAgentBudget,
      reassemblies: 0, observedAt }))
    const terminal = await f.journal.append(agentTurnSettledEvent, state => ({ turn: opened.turn.stored.eventId,
      outcome: 'completed' as const, rootOutcome: 'completed' as const, reason: 'model-final', disposition: 'handled' as const,
      finalStep: opened.step.stored.eventId, budget: state.roots[0]!.budget }))
    await runner.dispose()
    const recovered = await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null,
      maxRecoveryWrites: 10, maxJournalConflicts: 4, clock: { now: () => clock.now() + 60_001 } })
    expect(recovered.report.roots[0]?.outcome).toBe('completed')
    expect(projectAgentSession(f.session.snapshot()).turns[0]?.settled).toEqual(terminal)
    expect(recovered.report.final?.text).toBe('done')
    const fork = await f.repo.fork(f.session.header.sessionId)
    const inherited = projectAgentSession(fork.snapshot())
    expect(inherited.roots).toEqual([]); expect(inherited.inputs).toEqual([])
  } finally { await runner.dispose(); await f.close() }
})

it('preserves unknown Model cleanup ahead of expiry during recovery', async () => {
  const f = await agentFixture({}, auditProvider({ onClose: () => { throw new Error('cleanup failed') } }))
  const runner = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  try {
    const opened = await openStep(f)
    const assembly = await f.context.assembleAgent(opened.consumer)
    if (assembly.kind !== 'ready') throw new Error('assembly unavailable')
    await expect(runner.invoke(assembly.request, { inputPrecondition: assembly.inputPrecondition })).rejects.toMatchObject({ code: 'MODEL_CLEANUP_FAILED' })
    await runner.dispose().catch(() => undefined)
    const recovered = await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null,
      maxRecoveryWrites: 10, maxJournalConflicts: 4, clock: { now: () => clock.now() + 60_001 } })
    expect(recovered.report.roots[0]?.outcome).toBe('result-unknown')
    expect(recovered.report.final).toBeNull()
    expect(inspectAgentReadiness(f.session.snapshot(), emptyMessageCatalog, observedAt)).toMatchObject({
      canRun: false, canMaintain: false, blockedBy: 'cleanup-incomplete',
    })
  } finally { await runner.dispose().catch(() => undefined); await f.close().catch(() => undefined) }
})

it('offers maintenance rather than a business Run for a committed root stop', async () => {
  const f = await agentFixture({ nativeActions: ['agent_ask_user'] }, auditProvider({ script: async function* () {
    yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'question' }
    yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'ask', name: 'agent_ask_user' }
    yield { kind: 'arguments-delta', index: 0, text: '{"question":"continue?","timeoutMs":1000}' }
    yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
  } }))
  const agent = auditedAgent(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'question task', originLabel: 'audit' })
    const report = await agent.start()
    await agent.submitInput({ kind: 'task', text: 'later task', originLabel: 'audit' })
    await f.journal.append(agentControlRequestedEvent, () => ({ kind: 'cancel-work' as const,
      root: report.roots[0]!.id, reason: 'cancel' }))
    expect(inspectAgentReadiness(f.session.snapshot(), emptyMessageCatalog, observedAt)).toMatchObject({
      canRun: false, canMaintain: true, counts: { runnableInputs: 1 },
    })
    await agent.maintain()
    expect(inspectAgentReadiness(f.session.snapshot(), emptyMessageCatalog, observedAt)).toMatchObject({ canRun: true })
  } finally { await agent.dispose(); await f.close() }
})

it('reports an unfinished abandonment as recovery-required before admitting another input', async () => {
  const f = await agentFixture()
  try {
    const first = await f.journal.acceptInput({ kind: 'task', text: 'discard', originLabel: 'audit' })
    await f.journal.acceptInput({ kind: 'task', text: 'later task', originLabel: 'audit' })
    await f.journal.append(agentInputAbandonRequestedEvent, () => ({ kind: 'abandon-input' as const,
      input: { kind: 'user' as const, eventId: first.stored.eventId }, reason: 'discard' }))
    const position = f.session.snapshot().localPosition
    expect(inspectAgentReadiness(f.session.snapshot(), emptyMessageCatalog, observedAt)).toMatchObject({
      canRun: false, canMaintain: false, blockedBy: 'recovery-required', counts: { runnableInputs: 1 },
    })
    expect(f.session.snapshot().localPosition).toBe(position)
    await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null,
      maxRecoveryWrites: 10, maxJournalConflicts: 4, clock })
    expect(inspectAgentReadiness(f.session.snapshot(), emptyMessageCatalog, observedAt)).toMatchObject({ canRun: true })
  } finally { await f.close() }
})

it('keeps maintenance available when the business lane capacity is exceeded', async () => {
  const defaults = await agentFixture(); const limits = { ...defaults.spec.limits, maxLanes: 1 }; await defaults.close()
  const f = await agentFixture({ limits, messages: [{ type: requestMessage.type, payloadVersion: 1, requiresReply: false }] }, undefined, messageCatalog)
  const { service, policy } = createCommunicationService()
  const peer = await f.repo.create()
  const local = await service.attach(f.session, { catalog: messageCatalog, policy })
  const remote = await service.attach(peer, { catalog: messageCatalog, policy })
  const agent = auditedAgent(f, { mailbox: local, messageCatalog })
  try {
    await f.journal.acceptInput({ kind: 'task', text: 'later task', originLabel: 'audit' })
    for (const [index, text] of ['discard peer', 'later peer'].entries()) {
      await remote.send(requestMessage, { kind: 'root', recipient: f.session.header.address, channelId: parseChannelId(channelIds[index]!) }, { text })
      await service.createDispatcher(remote).dispatch()
    }
    const input = projectAgentSession(f.session.snapshot()).inputs.find(input => input.message !== null)!
    await f.journal.append(agentInputAbandonRequestedEvent, () => ({ kind: 'abandon-input' as const, input: input.reference, reason: 'discard' }))
    await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null,
      maxRecoveryWrites: 10, maxJournalConflicts: 4, clock })
    expect(inspectAgentReadiness(f.session.snapshot(), messageCatalog, observedAt)).toMatchObject({
      canRun: false, canMaintain: true, blockedBy: 'capacity', counts: { runnableInputs: 2, pendingMaintenance: 1 },
    })
    await agent.maintain()
    expect(local.snapshot().inbox[0]?.status).toBe('abandoned')
    expect(inspectAgentReadiness(f.session.snapshot(), messageCatalog, observedAt)).toMatchObject({ canRun: false, canMaintain: false })
  } finally { await agent.dispose(); await service.dispose(); await f.close() }
})

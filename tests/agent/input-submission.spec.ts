import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentJournal } from '../../src/agent/journal.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { decodeInputSubmission } from '../../src/agent/input-submission.js'
import { agentInputAcceptedEvent, agentKeyedInputAcceptedEvent, agentSpecRecordedEvent, agentSessionEventDefinitions, legacyAgentSessionEventDefinitions } from '../../src/agent/session-events.js'
import { FileSessionBackend, SessionRepository, createDurableEventCatalog, SessionContext, SessionAgent, SessionModelRunner,
  contextSessionEventDefinitions, modelSessionEventDefinitions, toolSessionEventDefinitions, communicationSessionEventDefinitions, MemorySessionBackend } from '../../src/index.js'
import { agentFixture, agentSpec, clock } from './fixtures.js'
import { profile, emptyMessageCatalog, runnerLimits, repository, scriptedModel } from '../context/fixtures.js'
import { loseFirstCommitAcknowledgement } from '../communication/fixtures.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'

const input = { kind: 'task' as const, text: 'research question', originLabel: 'api:alice' }
const identity = { namespace: 'api:alice', key: 'submission-1' }
const limits = { maxTurnsPerRun: 5, maxManagementPerRun: 20, maxDispatchRunsPerRun: 1, maxJournalConflicts: 4, maxReassemblies: 2,
  maxPendingInputs: 20, maxPendingWaits: 5, maxLanes: 10, maxInputBytes: 4096, maxActionsPerStep: 8, maxActionBytes: 4096,
  maxResultBytes: 16384, maxReportEntries: 100, maxWaitMs: 30_000 }

it('returns the original receipt without appending or consuming pending input capacity', async () => {
  const f = await agentFixture({ limits: { ...limits, maxPendingInputs: 1 } })
  try {
    const accepted = await f.journal.acceptKeyedInput(input, identity)
    const position = f.session.snapshot().localPosition
    const reused = await f.journal.acceptKeyedInput(input, identity)
    expect(reused).toEqual({ event: accepted.event, reused: true })
    expect(accepted.reused).toBe(false)
    expect(accepted.event.stored.payloadVersion).toBe(2)
    expect(f.session.snapshot().localPosition).toBe(position)
    await expect(f.journal.acceptKeyedInput(input, { ...identity, key: 'another' })).rejects.toMatchObject({ code: 'AGENT_STATE_INVALID' })
  } finally { await f.close() }
})

it('two independent journals race the same tuple with one durable acceptance', async () => {
  const f = await agentFixture(); const peer = new AgentJournal(f.session, 4, clock)
  try {
    const results = await Promise.all([f.journal.acceptKeyedInput(input, identity), peer.acceptKeyedInput(input, identity)])
    expect(results.map(result => result.reused).sort()).toEqual([false, true])
    expect(results[0]!.event.stored.eventId).toBe(results[1]!.event.stored.eventId)
    expect(projectAgentSession(f.session.snapshot()).inputs).toHaveLength(1)
  } finally { await f.close() }
})

it('rejects mismatched content and keeps namespaces as collision-free tuples', async () => {
  const f = await agentFixture()
  try {
    await f.journal.acceptKeyedInput(input, identity)
    for (const changed of [{ ...input, text: 'different' }, { ...input, originLabel: 'other' }]) {
      await expect(f.journal.acceptKeyedInput(changed, identity)).rejects.toMatchObject({ code: 'AGENT_KEY_CONFLICT' })
    }
    const a = await f.journal.acceptKeyedInput(input, { namespace: 'a:b', key: 'c' })
    const b = await f.journal.acceptKeyedInput(input, { namespace: 'a', key: 'b:c' })
    expect(a.event.stored.eventId).not.toBe(b.event.stored.eventId)
    await expect(f.journal.append(agentKeyedInputAcceptedEvent, () => a.event.payload)).rejects.toMatchObject({ message: 'duplicate-local-submission' })
    expect(projectAgentSession(f.session.snapshot()).inputs).toHaveLength(3)
  } finally { await f.close() }
})

it('unkeyed inputs keep their version 1 payload and never occupy a submission tuple', async () => {
  const f = await agentFixture()
  try {
    const legacy = await f.journal.acceptInput(input)
    const keyed = await f.journal.acceptKeyedInput(input, identity)
    expect(legacy.stored.payloadVersion).toBe(1)
    expect(legacy.stored.type).toBe(agentInputAcceptedEvent.type)
    expect(keyed.event.stored.eventId).not.toBe(legacy.stored.eventId)
  } finally { await f.close() }
})

it('rejects a repeated local submission when replaying a structurally valid durable log', async () => {
  const f = await agentFixture()
  try {
    const accepted = await f.journal.acceptKeyedInput(input, identity)
    await f.session.append(agentKeyedInputAcceptedEvent, accepted.event.payload)
    expect(() => projectAgentSession(f.session.snapshot())).toThrowError(expect.objectContaining({ code: 'AGENT_STATE_INVALID', message: 'duplicate-local-submission' }))
  } finally { await f.close() }
})

it('a legacy catalog can still accept version 1 and rejects a keyed write before advancing', async () => {
  const repo = repository(undefined, [...legacyAgentSessionEventDefinitions, ...toolSessionEventDefinitions, ...communicationSessionEventDefinitions])
  const session = await repo.create(); const provider = scriptedModel()
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
  try {
    const recorded = await context.recordProfile(profile('generation', { rendererVersion: 'context-neutral/v2' }))
    const journal = new AgentJournal(session, 4, clock)
    await journal.append(agentSpecRecordedEvent, () => agentSpec(recorded.stored.eventId, provider))
    await journal.acceptInput(input)
    const position = session.snapshot().localPosition
    await expect(journal.acceptKeyedInput(input, identity)).rejects.toMatchObject({ code: 'AGENT_CATALOG_INCOMPATIBLE' })
    expect(session.snapshot().localPosition).toBe(position)
  } finally { await context.dispose(); await provider.dispose(); await repo.dispose() }
})

it('counts the additional submission fields against the real backend record byte limit', async () => {
  const f = await agentFixture({}, undefined, emptyMessageCatalog, new MemorySessionBackend({ maxRecordBytes: 2048 }))
  try {
    const position = f.session.snapshot().localPosition
    await expect(f.journal.acceptKeyedInput({ ...input, text: 'x'.repeat(1900) }, identity)).rejects.toMatchObject({ code: 'AGENT_LIMIT_EXCEEDED' })
    expect(f.session.snapshot().localPosition).toBe(position)
    expect(f.journal.faulted).toBe(false)
  } finally { await f.close() }
})

it('a Fork accepts the same key in its own local Session rather than inheriting its parent index', async () => {
  const f = await agentFixture(); let context: SessionContext | undefined
  try {
    const parent = await f.journal.acceptKeyedInput(input, identity)
    const child = await f.repo.fork(f.session.header.sessionId)
    context = new SessionContext({ session: child, messageCatalog: emptyMessageCatalog })
    const recorded = await context.recordProfile(profile('generation', { rendererVersion: 'context-neutral/v2' }))
    const journal = new AgentJournal(child, 4, clock)
    await journal.append(agentSpecRecordedEvent, () => agentSpec(recorded.stored.eventId, f.provider))
    const accepted = await journal.acceptKeyedInput(input, identity)
    expect(accepted.reused).toBe(false)
    expect(accepted.event.stored.eventId).not.toBe(parent.event.stored.eventId)
    expect(projectAgentSession(child.snapshot()).inputs).toHaveLength(1)
  } finally { await context?.dispose(); await f.close() }
})

it('an acknowledged answer is reusable after its Wait settled; a new answer remains inadmissible', async () => {
  let calls = 0
  const provider = new ScriptedModelProvider({ providerId: 'keyed-question', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    script: async function* (): AsyncGenerator<ModelFrame> {
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'response' }
      if (calls++ === 0) {
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'question', name: 'agent_ask_user' }
        yield { kind: 'arguments-delta', index: 0, text: '{"question":"Which format?","timeoutMs":10000}' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } else {
        yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'done' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      }
    } })
  const f = await agentFixture({ nativeActions: ['agent_ask_user'] }, provider)
  const agent = new SessionAgent({ session: f.session, context: f.context, model: new SessionModelRunner({ session: f.session, provider, limits: runnerLimits }), messageCatalog: emptyMessageCatalog, clock })
  try {
    await f.journal.acceptKeyedInput(input, identity)
    const waiting = await agent.start()
    const answer = { kind: 'answer' as const, wait: waiting.waits[0]!.reference, text: 'Markdown', originLabel: 'api:alice' }
    const accepted = await f.journal.acceptKeyedInput(answer, { ...identity, key: 'answer' })
    await agent.start()
    expect((await f.journal.acceptKeyedInput(answer, { ...identity, key: 'answer' })).event.stored.eventId).toBe(accepted.event.stored.eventId)
    await expect(f.journal.acceptKeyedInput(answer, { ...identity, key: 'late-answer' })).rejects.toMatchObject({ message: 'answer-wait-terminal' })
  } finally { await agent.dispose(); await f.close() }
})

it('reopens an input whose commit acknowledgement was lost and reuses its durable receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-keyed-input-'))
  const f = await agentFixture({}, undefined, emptyMessageCatalog,
    loseFirstCommitAcknowledgement(new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }), 'agent/input-accepted'))
  let reopened: SessionRepository | undefined
  try {
    await expect(f.journal.acceptKeyedInput(input, identity)).rejects.toMatchObject({ code: 'AGENT_COMMIT_UNKNOWN' })
    expect(projectAgentSession(f.session.snapshot()).inputs).toHaveLength(0)
    await expect(f.journal.acceptKeyedInput(input, identity)).rejects.toMatchObject({ code: 'AGENT_RECOVERY_REQUIRED' })
    await f.close()
    reopened = new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }), maxLineageDepth: 8,
      catalog: createDurableEventCatalog([...contextSessionEventDefinitions, ...modelSessionEventDefinitions, ...toolSessionEventDefinitions, ...communicationSessionEventDefinitions, ...agentSessionEventDefinitions]), clock })
    const session = await reopened.open(f.session.header.sessionId)
    const receipt = await new AgentJournal(session, 4, clock).acceptKeyedInput(input, identity)
    expect(receipt.reused).toBe(true)
    expect(projectAgentSession(session.snapshot()).inputs).toHaveLength(1)
  } finally { await f.close(); await reopened?.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.each([{ namespace: '', key: 'ok' }, { namespace: 'api:alice', key: 'a b' }, { namespace: 'n'.repeat(65), key: 'ok' }])('rejects malformed durable submission identity %#', identity => {
  expect(() => decodeInputSubmission(identity)).toThrow()
})

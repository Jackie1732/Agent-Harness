import { expect, it } from 'vitest'
import { rebuildAssembly } from '../../src/context/projection.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { agentInputAcceptedEvent } from '../../src/agent/session-events.js'
import { agentFixture, openStep } from './fixtures.js'
import { runnerLimits } from '../context/fixtures.js'
import { SessionAgent, ScriptedModelProvider, createMessageCatalog } from '../../src/index.js'
import type { ModelFrame } from '../../src/index.js'
import { clock } from './fixtures.js'

it('includes only the claimed input and reconstructs the entire v2 assembly without runtime providers', async () => {
  const f = await agentFixture()
  try {
    const opened = await openStep(f)
    await f.journal.append(agentInputAcceptedEvent, () => ({ spec: f.installed.stored.eventId, input: { kind: 'task' as const, text: 'queued secret', originLabel: 'test' } }))
    const built = await f.context.assembleAgent(opened.consumer)
    expect(built.kind).toBe('ready')
    if (built.kind !== 'ready') return
    expect(JSON.stringify(built.request)).toContain('claimed task')
    expect(JSON.stringify(built.request)).not.toContain('queued secret')
    expect(rebuildAssembly(f.session.snapshot(), built.committed.stored.eventId)).toMatchObject({ kind: 'rebuilt', request: built.request })
    const runner = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
    try {
      await runner.invoke(built.request, { inputPrecondition: built.inputPrecondition })
      expect(rebuildAssembly(f.session.snapshot(), built.committed.stored.eventId)).toMatchObject({ kind: 'rebuilt', adoption: { kind: 'adopted' } })
    } finally { await runner.dispose() }
  } finally { await f.close() }
})

it('requires the exact open step rather than accepting another input as a model consumer', async () => {
  const f = await agentFixture()
  try {
    const opened = await openStep(f)
    await expect(f.context.assembleAgent({ ...opened.consumer, turn: opened.input.stored.eventId })).rejects.toMatchObject({ code: 'CONTEXT_SOURCE_INVALID' })
  } finally { await f.close() }
})

it('advertises configured native actions in the committed request', async () => {
  const f = await agentFixture({ nativeActions: ['agent_ask_user'] })
  try {
    const opened = await openStep(f)
    const result = await f.context.assembleAgent(opened.consumer)
    expect(result.kind).toBe('ready')
  } finally { await f.close() }
})

it('reassembles a stale claim context without spending a second model opportunity or issuing the stale request', async () => {
  let agent: SessionAgent
  let added: Promise<unknown> | undefined
  let preparations = 0; let starts = 0
  const provider = new ScriptedModelProvider({ providerId: 'context-race', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    onPrepare: () => {
      if (preparations++ === 0) added = agent.submitInput({ kind: 'task', text: 'later unclaimed input', originLabel: 'test' })
    }, script: async function* (): AsyncGenerator<ModelFrame> {
      starts++
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'response' }
      yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'answer' }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
    } })
  const f = await agentFixture({}, provider)
  const model = new SessionModelRunner({ session: f.session, provider, limits: runnerLimits })
  agent = new SessionAgent({ session: f.session, model, context: f.context, messageCatalog: createMessageCatalog(), clock })
  try {
    await agent.submitInput({ kind: 'task', text: 'claimed task', originLabel: 'test' })
    const report = await agent.start(); await added
    expect(report.roots.map(root => root.budget.models)).toEqual([1, 1])
    expect(starts).toBe(2)
    expect(agent.snapshot().steps[0]?.decided?.payload.reassemblies).toBe(1)
    expect(JSON.stringify(model.snapshot().invocations[0]?.prepared.payload.submission.request)).not.toContain('later unclaimed input')
    const assemblies = f.session.snapshot().history.at(-1)!.events.filter(event => event.stored.type === 'context/assembly-committed')
    expect(assemblies).toHaveLength(3)
    for (const event of assemblies) expect(rebuildAssembly(f.session.snapshot(), event.stored.eventId).kind).toBe('rebuilt')
  } finally { await agent.dispose(); await f.close() }
})

it('includes only the configured number of completed roots as optional history', async () => {
  const f = await agentFixture({ context: { history: { mode: 'completed-roots', maxRoots: 1 },
    memory: { required: [], query: { requiredTags: [], queryTags: [], topK: 0 } }, compactions: [] } })
  const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  const agent = new SessionAgent({ session: f.session, model, context: f.context, messageCatalog: createMessageCatalog(), clock })
  try {
    for (const text of ['first unique task', 'second unique task', 'third unique task']) {
      await agent.submitInput({ kind: 'task', text, originLabel: 'test' }); await agent.start()
    }
    const request = JSON.stringify(model.snapshot().invocations.at(-1)?.prepared.payload.submission.request)
    expect(request).toContain('second unique task'); expect(request).toContain('third unique task'); expect(request).not.toContain('first unique task')
  } finally { await agent.dispose(); await f.close() }
})

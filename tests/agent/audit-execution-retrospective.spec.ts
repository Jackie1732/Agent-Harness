import { expect, it } from 'vitest'
import { MemorySessionBackend, SessionAgent, SessionContext, SessionModelRunner, SessionRepository, createDurableEventCatalog, installAgentSpec } from '../../src/index.js'
import type { AgentSpecV2, AgentSpecV3, ModelFrame } from '../../src/index.js'
import { agentSessionEventDefinitions } from '../../src/agent/session-events.js'
import { subagentSessionEventDefinitions } from '../../src/subagent/session-events.js'
import { SubagentError } from '../../src/subagent/errors.js'
import { communicationSessionEventDefinitions } from '../../src/communication/session-events.js'
import { CommunicationError } from '../../src/communication/errors.js'
import { workflowSessionEventDefinitions } from '../../src/workflow/session-events.js'
import { contextSessionEventDefinitions } from '../../src/context/session-events.js'
import { modelSessionEventDefinitions } from '../../src/model/session-events.js'
import { emptyMessageCatalog, profile, repository, runnerLimits } from '../context/fixtures.js'
import { agentFixture, agentSpec, clock } from './fixtures.js'
import { auditProvider, auditedAgent, finalFrames, interceptedBackend } from './audit-fixtures.js'
import { createCommunicationService, messageCatalog, requestMessage } from '../communication/fixtures.js'
import { createChannelId } from '../../src/communication/ids.js'
import { formatSessionAddress, parseSessionId } from '../../src/session/ids.js'

async function subagentActionFixture(version: 2 | 3, failure: Error) {
  let calls = 0
  const provider = auditProvider({ script: async function* (): AsyncGenerator<ModelFrame> {
    if (calls++ > 0) { yield* finalFrames(); return }
    yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'delegate' }
    yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'spawn', name: 'agent_spawn_subagent' }
    yield { kind: 'arguments-delta', index: 0, text: '{"templateKey":"research","templateVersion":1,"task":"Inspect evidence","materials":[],"requestedBudget":{"models":1,"steps":1,"tools":0,"messages":0,"waits":0,"outputTokens":256},"workspace":{"kind":"none"}}' }
    yield { kind: 'block-end', index: 0 }
    yield { kind: 'complete', stopReason: 'tool-calls' }
  } })
  const repo = repository(undefined, [...agentSessionEventDefinitions, ...subagentSessionEventDefinitions,
    ...communicationSessionEventDefinitions, ...workflowSessionEventDefinitions])
  const session = await repo.create()
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
  const recorded = await context.recordProfile(profile('generation', { rendererVersion: version === 2 ? 'context-neutral/v3' : 'context-neutral/v4' }))
  const base = agentSpec(recorded.stored.eventId, provider)
  const parent: AgentSpecV2 = { ...base, protocolVersion: 2, nativeActions: ['agent_spawn_subagent'], subagents: {
    role: 'parent', templates: [{ templateKey: 'research', templateVersion: 1 }],
    capabilities: { models: [{ providerId: provider.descriptor.providerId, model: 'fixture-model' }], tools: [], workspaces: [] },
    maxDelegations: 1, maxGrant: base.budget,
  } }
  const spec: AgentSpecV2 | AgentSpecV3 = version === 2 ? parent : { ...parent, protocolVersion: 3, workflow: { kind: 'disabled' } }
  await installAgentSpec(session, spec, clock)
  const agent = new SessionAgent({ session, context, messageCatalog: emptyMessageCatalog, clock,
    model: new SessionModelRunner({ session, provider, limits: runnerLimits }),
    subagentActions: { async execute() { throw failure } },
  })
  return { agent, calls: () => calls, async close() { await agent.dispose(); await provider.dispose(); await repo.dispose() } }
}

it('retains the first accepted outbox action and closes the remaining batch when cancellation arrives', async () => {
  const stop = new AbortController()
  let calls = 0
  const provider = auditProvider({ script: async function* (): AsyncGenerator<ModelFrame> {
    calls++
    yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'send' }
    for (const index of [0, 1]) {
      yield { kind: 'block-start', index, block: 'tool-call', callId: `send-${index}`, name: 'agent_send_message' }
      yield { kind: 'arguments-delta', index, text: JSON.stringify({ peerKey: 'peer', type: requestMessage.type, payloadVersion: 1,
        payloadJson: JSON.stringify({ text: `message-${index}` }) }) }
      yield { kind: 'block-end', index }
    }
    yield { kind: 'complete', stopReason: 'tool-calls' }
  } })
  const { service, policy } = createCommunicationService()
  const next = await agentFixture({ nativeActions: ['agent_send_message'], peers: [{ key: 'peer', address: formatSessionAddress(parseSessionId('30000000-0000-4000-8000-000000000103')), channelId: createChannelId() }],
    messages: [{ type: requestMessage.type, payloadVersion: 1, requiresReply: false }] }, provider, messageCatalog,
    interceptedBackend(async () => {}, async event => { if (event.type === 'communication/outbox-accepted') stop.abort() }))
  const mailbox = await service.attach(next.session, { catalog: messageCatalog, policy })
  const agent = auditedAgent(next, { mailbox, messageCatalog })
  try {
    await agent.submitInput({ kind: 'task', text: 'send twice', originLabel: 'audit' })
    await agent.submitInput({ kind: 'task', text: 'later task', originLabel: 'audit' })
    const result = await agent.start({ signal: stop.signal })
    expect(calls).toBe(1)
    expect(result.roots[0]).toMatchObject({ outcome: 'cancelled', budget: { models: 1, messages: 2 } })
    expect(mailbox.snapshot().outbox).toHaveLength(1)
    expect(agent.snapshot().actions.map(action => action.payload.result.kind)).toEqual(['outbox', 'not-started'])
    expect(agent.snapshot().actions[1]?.payload.result).toEqual({ kind: 'not-started', reason: 'cancelled-before-action' })
    expect(agent.snapshot().inputs.map(input => input.status)).toEqual(['review-required', 'queued'])
  } finally { await agent.dispose(); await service.dispose(); await next.close() }
})

for (const offset of [0, 1]) it(`uses the accepted user answer time at the exact wait deadline: offset=${offset}`, async () => {
  let now = clock.now()
  let calls = 0
  const currentClock = { now: () => now }
  const provider = auditProvider({ script: async function* (): AsyncGenerator<ModelFrame> {
    if (calls++ > 0) { yield* finalFrames(); return }
    yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'ask' }
    yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'ask', name: 'agent_ask_user' }
    yield { kind: 'arguments-delta', index: 0, text: '{"question":"Continue?","timeoutMs":10000}' }
    yield { kind: 'block-end', index: 0 }
    yield { kind: 'complete', stopReason: 'tool-calls' }
  } })
  const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 2 * 1024 * 1024 }),
    catalog: createDurableEventCatalog([...contextSessionEventDefinitions, ...modelSessionEventDefinitions,
      ...agentSessionEventDefinitions, ...communicationSessionEventDefinitions]), maxLineageDepth: 8, clock: currentClock })
  const session = await repo.create()
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
  const recorded = await context.recordProfile(profile('generation', { rendererVersion: 'context-neutral/v2' }))
  await installAgentSpec(session, agentSpec(recorded.stored.eventId, provider, { nativeActions: ['agent_ask_user'] }), currentClock)
  const agent = new SessionAgent({ session, context, clock: currentClock, messageCatalog: emptyMessageCatalog,
    model: new SessionModelRunner({ session, provider, limits: runnerLimits }) })
  try {
    await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'audit' })
    const waiting = await agent.start()
    const wait = waiting.waits[0]!
    const created = wait.created.payload.result
    if (created.kind !== 'wait') throw new Error('fixture did not create a wait')
    now = Date.parse(created.descriptor.deadline) + offset
    const answer = await agent.submitInput({ kind: 'answer', wait: wait.reference, text: 'yes', originLabel: 'audit' })
    expect(Date.parse(answer.stored.recordedAt)).toBe(now)
    now++
    const result = await agent.start()
    expect(calls).toBe(offset === 0 ? 2 : 1)
    expect(agent.snapshot().waits[0]?.settled?.payload.outcome).toBe(offset === 0 ? 'matched' : 'timed-out')
    expect(result.roots[0]).toMatchObject({ outcome: offset === 0 ? 'completed' : 'timed-out', budget: { waits: 1 } })
    expect(agent.snapshot().inputs.at(-1)?.status).toBe(offset === 0 ? 'handled' : 'not-adopted')
  } finally { await agent.dispose(); await provider.dispose(); await repo.dispose() }
})

for (const version of [2, 3] as const) for (const aggregate of [false, true]) {
  it(`stops after a subagent resource failure without turning it into model feedback: v${version}, aggregate=${aggregate}`, async () => {
    const cause = new Error('resource close failed')
    const failure = aggregate ? new AggregateError([cause], 'subagent resource release failed') : cause
    const f = await subagentActionFixture(version, failure)
    try {
      await f.agent.submitInput({ kind: 'task', text: 'first', originLabel: 'audit' })
      await f.agent.submitInput({ kind: 'task', text: 'second', originLabel: 'audit' })
      const result = await f.agent.start().then(() => 'resolved', error => error)
      expect(result).toBe(failure)
      expect(f.calls()).toBe(1)
      expect(f.agent.status).toBe('faulted')
      expect(f.agent.snapshot().actions).toEqual([])
      expect(f.agent.snapshot().roots[0]?.outcome).toBeNull()
      expect(f.agent.snapshot().inputs.map(input => input.status)).toEqual(['claimed', 'queued'])
    } finally { await f.close() }
  })
}

for (const version of [2, 3] as const) {
  for (const channelCapacity of [false, true]) it(`keeps an explicit subagent capacity rejection as bounded model feedback: v${version}, channel=${channelCapacity}`, async () => {
    const failure = channelCapacity ? new CommunicationError('MESSAGE_OUTBOX_FULL', 'protocol-capacity')
      : new SubagentError('SUBAGENT_CAPACITY', 'active-child-limit')
    const f = await subagentActionFixture(version, failure)
    try {
      await f.agent.submitInput({ kind: 'task', text: 'task', originLabel: 'audit' })
      const result = await f.agent.start()
      expect(f.calls()).toBe(2)
      expect(result.roots[0]?.outcome).toBe('completed')
      expect(f.agent.snapshot().actions[0]?.payload.result).toEqual({ kind: 'not-started', reason: channelCapacity ? 'native-arguments-invalid' : 'active-child-limit' })
      expect(f.agent.status).toBe('accepting')
    } finally { await f.close() }
  })
}

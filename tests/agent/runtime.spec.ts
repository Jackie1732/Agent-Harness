import { expect, it } from 'vitest'
import { SessionModelRunner } from '../../src/model/runner.js'
import { SessionAgent } from '../../src/agent/session-agent.js'
import { agentFixture, clock } from './fixtures.js'
import { emptyMessageCatalog, runnerLimits } from '../context/fixtures.js'

it('drives queued tasks in separate claims and returns the final committed model result', async () => {
  const f = await agentFixture()
  const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  const agent = new SessionAgent({ session: f.session, model, context: f.context, messageCatalog: emptyMessageCatalog, clock })
  try {
    await agent.submitInput({ kind: 'task', text: 'first task', originLabel: 'test' })
    await agent.submitInput({ kind: 'task', text: 'second task', originLabel: 'test' })
    const task = agent.start()
    expect(agent.start()).toBe(task)
    expect(agent.wait()).toBe(task)
    const report = await task
    expect(report.final?.text).toBe('model answer')
    expect(report.openRun).toBeNull()
    expect(report.inputs.map(input => input.status)).toEqual(['handled', 'handled'])
    expect(report.roots.map(root => root.budget.models)).toEqual([1, 1])
    expect(report.modelUsage).toHaveLength(2)
    expect(report.modelUsage[0]?.usage).toMatchObject({ completeness: 'complete', inputTokens: 10, outputTokens: 3 })
    const requests = model.snapshot().invocations.map(call => JSON.stringify(call.prepared.payload.submission.request))
    expect(requests[0]).toContain('first task'); expect(requests[0]).not.toContain('second task')
    expect(requests[1]).toContain('second task'); expect(requests[1]).not.toContain('first task')
    await agent.endSession()
    expect(f.session.snapshot().lifecycle).toBe('ended')
  } finally { await agent.dispose(); await f.close() }
})

it('reserves no model opportunity when the root budget is exhausted', async () => {
  const f = await agentFixture({ budget: { models: 0, steps: 0, tools: 0, messages: 0, waits: 0, outputTokens: 0 } })
  const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  const agent = new SessionAgent({ session: f.session, model, context: f.context, messageCatalog: emptyMessageCatalog, clock })
  try {
    const accepted = await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'test' })
    const report = await agent.start()
    expect(report.roots[0]?.outcome).toBe('budget-exhausted')
    expect(report.inputs[0]?.status).toBe('review-required')
    expect(model.snapshot().invocations).toHaveLength(0)
    await expect(agent.endSession()).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    await agent.abandonInput({ kind: 'user', eventId: accepted.stored.eventId })
    await agent.endSession()
  } finally { await agent.dispose(); await f.close() }
})

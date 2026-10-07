import { expect, it } from 'vitest'
import { agentFixture } from './fixtures.js'
import { auditedAgent, auditProvider, finalFrames } from './audit-fixtures.js'
import { selectAgentRoot, selectUserInput } from '../../src/agent/observation.js'
import { snapshotCuts, mergeCuts } from '../../src/host/read-cuts.js'
import { createDeepSeekModelProvider } from '../../src/model/providers/deepseek.js'
import { httpFixture, sse, streamLimits } from '../model/fixtures.js'
import { projectModelSession } from '../../src/model/projection.js'

it.each(['final answer', ''])('selects exact final text beside a complete Provider continuation: %j', async text => {
  const chunk = (delta: object, finish: string | null) => sse('', { id: 'root-final', object: 'chat.completion.chunk', created: 1,
    model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })
  const http = await httpFixture(response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(chunk({ role: 'assistant', reasoning_content: 'continuation retained' }, null)
      + chunk({ content: text }, 'stop') + sse('', '[DONE]'))
  })
  const provider = createDeepSeekModelProvider({ providerId: 'root-http', endpoint: http.endpoint, apiKey: 'test', maxConcurrentExchanges: 1, streamLimits })
  const f = await agentFixture({ target: { model: 'fixture-model', maxOutputTokens: 256, provider: provider.descriptor,
    profile: { namespace: 'deepseek.chat', version: 1, options: { thinking: 'enabled' } } } }, provider), agent = auditedAgent(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'Complete', originLabel: 'test' })
    const report = await agent.start(), id = report.roots[0]!.id
    const invocation = projectModelSession(f.session.snapshot()).invocations.at(-1)!
    expect(invocation.state === 'settled' ? invocation.settled.payload.failure : invocation.state).toBeUndefined()
    const original = f.session.snapshot(), root = selectAgentRoot(original, id, 16384)!
    expect(root).toMatchObject({ outcome: 'completed', executionPending: false, final: { text, textBytes: Buffer.byteLength(text), textOmitted: false } })
    const child = await f.repo.fork(f.session.header.sessionId)
    expect(selectAgentRoot(child.snapshot(), id, 16384)).toBeNull()
    expect(selectUserInput(child.snapshot(), { inputEventId: report.inputs[0]!.reference.eventId })).toBeNull()
    const cuts = mergeCuts([...snapshotCuts(original), ...snapshotCuts(child.snapshot())])
    expect(cuts.find(cut => cut.sessionId === original.header.sessionId)!.through).toBe(original.localPosition)
    expect(cuts.find(cut => cut.sessionId === child.header.sessionId)!.through).toBe(child.snapshot().localPosition)
    const missing = { ...original, history: original.history.map(segment => ({ ...segment,
      events: segment.events.filter(item => item.stored.eventId !== root.final!.modelSettledId) })) }
    expect(() => selectAgentRoot(missing, id, 16384)).toThrow()
  } finally { await agent.dispose(); await f.close(); await http.close() }
})

it('keeps a Root resource pending after its real Model owner fails cleanup', async () => {
  const f = await agentFixture({}, auditProvider({ onClose: () => { throw new Error('release failed') }, script: finalFrames }))
  const agent = auditedAgent(f)
  try {
    await agent.submitInput({ kind: 'task', text: 'Complete', originLabel: 'test' })
    const report = await agent.start()
    expect(selectAgentRoot(f.session.snapshot(), report.roots[0]!.id, 16384)).toMatchObject({ outcome: 'result-unknown', final: null, executionPending: true })
    expect(agent.status).toBe('faulted')
  } finally { await agent.dispose().catch(() => undefined); await f.close().catch(() => undefined) }
})

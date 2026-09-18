import assert from 'node:assert/strict'
import * as h from '../dist/index.js'
import { agentSpec } from './agent-fixture.mjs'
import { contextProfile, modelLimits, sessionRepository, scriptedTextProvider } from './context-fixture.mjs'

const repository = sessionRepository(new h.MemorySessionBackend({ maxRecordBytes: 2 * 1024 * 1024 }), h.agentSessionEventDefinitions)
const catalog = h.createMessageCatalog()
const questioner = new h.ScriptedModelProvider({ providerId: 'context-example', maxConcurrentExchanges: 1,
  streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
  script: async function* () {
    yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'question' }
    yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'question-1' }
    yield { kind: 'arguments-delta', index: 0, text: '{"question":"Which output format?","timeoutMs":30000}' }
    yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
  } })
const answerer = scriptedTextProvider('The report will use Markdown.')
const agents = []
try {
  const session = await repository.create()
  const context = new h.SessionContext({ session, messageCatalog: catalog })
  const profile = await context.recordProfile(contextProfile('generation', { rendererVersion: 'context-neutral/v2' }))
  await h.installAgentSpec(session, agentSpec(profile.stored.eventId, questioner.descriptor, { nativeActions: ['agent_ask_user'] }), h.systemClock)
  const first = new h.SessionAgent({ session, context, model: new h.SessionModelRunner({ session, provider: questioner, limits: modelLimits }), messageCatalog: catalog, clock: h.systemClock })
  agents.push(first)
  await first.submitInput({ kind: 'task', text: 'Prepare a short report.', originLabel: 'example' })
  const waiting = await first.start()
  assert.equal(waiting.waits.length, 1)
  await first.dispose()

  const resumed = new h.SessionAgent({ session, context: new h.SessionContext({ session, messageCatalog: catalog }),
    model: new h.SessionModelRunner({ session, provider: answerer, limits: modelLimits }), messageCatalog: catalog, clock: h.systemClock })
  agents.push(resumed)
  await resumed.submitInput({ kind: 'answer', wait: waiting.waits[0].reference, text: 'Markdown.', originLabel: 'example-user' })
  const result = await resumed.start()
  assert.equal(result.roots.length, 1)
  assert.equal(result.roots[0].budget.models, 2)
  assert.equal(result.roots[0].budget.waits, 1)
  assert.equal(result.final.text, 'The report will use Markdown.')
  await resumed.endSession()
  const snapshot = session.snapshot()
  for (const event of snapshot.history.at(-1).events.filter(event => event.stored.type === 'context/assembly-committed')) assert.equal(h.rebuildAssembly(snapshot, event.stored.eventId).kind, 'rebuilt')
  process.stdout.write(`${JSON.stringify({ example: 'agent-ask-user', turns: h.projectAgentSession(snapshot).turns.length, budget: result.roots[0].budget, final: result.final.text })}\n`)
} finally {
  for (const agent of agents.reverse()) await agent.dispose()
  await questioner.dispose(); await answerer.dispose(); await repository.dispose()
}

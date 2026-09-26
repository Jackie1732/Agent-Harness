import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:https'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../../dist/index.js'
import { workflowConfig, resolveWorkflowConfig } from '../../examples/workflow-fixture.mjs'
import { captureFileCommits } from '../helpers/subagent-prefixes.mjs'
import { verifyParallelRecovery } from '../helpers/workflow-parallel-recovery.mjs'

const directory = await mkdtemp(join(tmpdir(), 'workflow-parallel-'))
const bodies = [], pending = []
const mode = process.argv[2] ?? 'complete'
let reached, closed
const bothReached = new Promise(resolve => { reached = resolve })
const responsesClosed = new Promise(resolve => { closed = resolve })
let active = 0, peak = 0, host, serving, ordinarySubmission
const server = createServer({ cert: await readFile(new URL('../host/certs/server.pem', import.meta.url)),
  key: await readFile(new URL('../host/certs/server-key.pem', import.meta.url)) }, async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const value = JSON.parse(body)
  bodies.push(value)
  active++; peak = Math.max(peak, active)
  response.once('close', () => { active--; if (active === 0 && bodies.length >= 2) closed() })
  const text = 'evidence-' + bodies.length
  const respond = () => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ id: text, object: 'chat.completion.chunk', created: 1, model: value.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } }) + '\n\ndata: [DONE]\n\n')
  }
  if (bodies.length <= 2) {
    pending.push(respond)
    if (pending.length === 2) {
      reached()
      // Queue ordinary work while both HTTP responses are held. Its request must follow both.
      if (mode === 'complete') ordinarySubmission = host.submitTask('ordinary', 'ordinary-only-input').then(() => { for (const reply of pending) reply() })
    }
  } else {
    assert.equal(active, 1, 'ordinary work overlapped a reader')
    respond()
  }
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const endpoint = `https://127.0.0.1:${server.address().port}/model`
try {
  const raw = await workflowConfig(directory)
  raw.workflows.maxBusinessConcurrency = 2
  const ordinary = structuredClone(raw.members[0])
  ordinary.agentKey = 'ordinary'; ordinary.sessionId = '70000000-0000-4000-8000-000000000103'
  ordinary.spec.workflow = { kind: 'disabled' }
  ordinary.spec.peers = []; ordinary.spec.messages = []; ordinary.spec.nativeActions = []
  raw.members.push(ordinary)
  raw.routes.push({ memberKey: 'ordinary', ownerHost: raw.hostKey, origin: null, serverName: null })
  for (const member of raw.members) {
    const { text: _text, ...model } = member.model
    member.model = { ...model, kind: 'deepseek', endpoint, credentialRef: 'local-fixture' }
  }
  const spec = resolveWorkflowConfig(raw)
  const now = Date.now(), clock = { now: () => now }
  const frames = await captureFileCommits(async () => {
  await h.initializeHost(spec, { clock })
  host = await h.openHost(spec, { clock, credentials: { 'local-fixture': 'local-only' } })
  await host.workflow('research').resume({ requestKey: 'start' })
  const timeout = AbortSignal.timeout(90000)
  serving = host.serve({ signal: timeout })
  if (mode === 'cancel') {
    await bothReached
    await host.shutdown({ mode: 'cancel' }); await serving; await responsesClosed
    assert.equal(host.status, 'stopped')
    assert.equal(active, 0)
    assert.equal(peak, 2)
    assert.equal(bodies.length, 2)
  } else {
    const observation = await host.workflow('research').wait({ until: 'closed', timeoutMs: 85000 })
    assert.equal(observation.status, 'condition-met', JSON.stringify(host.report()))
    await ordinarySubmission
    // The same public driver continues until the ordinary root has completed.
    while (host.report().members.find(member => member.agentKey === 'ordinary').agent.roots[0]?.outcome !== 'completed') {
      if (timeout.aborted) throw new Error('ordinary root did not settle')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await host.shutdown({ mode: 'drain' }); await serving
    assert.equal(peak, 2)
    assert.equal(bodies.length, 3)
    assert.ok(JSON.stringify(bodies[0]).includes('writer'))
    assert.ok(JSON.stringify(bodies[1]).includes('reviewer'))
    assert.ok(JSON.stringify(bodies[2]).includes('ordinary-only-input'))
    assert.ok(!JSON.stringify(bodies[0]).includes('ordinary-only-input'))
  }
  })
  if (mode === 'complete') {
    await verifyParallelRecovery(raw, frames, clock)
    assert.equal(bodies.length, 3, 'recovery emitted a model request')
  }
  const repository = new h.SessionRepository({ backend: new h.FileSessionBackend(spec.storage), catalog: h.hostRuntimeEventCatalog, maxLineageDepth: 4 })
  try {
    for (const [index, member] of spec.members.filter(member => mode === 'complete' || member.agentKey !== 'ordinary').entries()) {
      const snapshot = (await repository.open(h.parseSessionId(member.sessionId))).snapshot()
      const agent = h.projectAgentSession(snapshot)
      assert.equal(agent.roots.length, 1)
      assert.equal(agent.roots[0].budget.models, 1)
      assert.equal(agent.roots[0].outcome, mode === 'cancel' ? 'cancelled' : 'completed')
      const results = snapshot.history.at(-1).events.filter(item => item.stored.type === 'model/invocation-settled')
      assert.equal(results.length, 1)
      if (mode === 'complete') assert.ok(JSON.stringify(results[0].payload).includes('evidence-' + (index + 1)))
    }
  } finally { await repository.dispose() }
  console.log('parallel HTTPS roots verified')
} finally {
  await host?.shutdown({ mode: 'cancel' }); await serving
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}

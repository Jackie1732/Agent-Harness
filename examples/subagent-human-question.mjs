import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { subagentConfig, clock, delegationRequest, action, final, protocolInput } from './subagent-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'harness-question-'))
let host
let parentCalls = 0; let childCalls = 0; let question
try {
  const spec = h.resolveHostConfig(h.decodeHostConfig(await subagentConfig(root), root))
  await h.initializeHost(spec, { clock })
  const bindings = { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model, script: async function* (submission) {
    const parent = member.agentKey === 'writer'; const call = parent ? parentCalls++ : childCalls++
    yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'human-question' }
    if (parent && call === 0) yield* action('agent_spawn_subagent', delegationRequest())
    else if (!parent && call === 0) yield* action('agent_ask_parent', { question: 'Which output format?', timeoutMs: 30000 })
    else if (parent && call === 1) {
      question = protocolInput(submission, 'subagent-question')
      yield* action('agent_ask_user', { question: question.payload.question, timeoutMs: 30000 })
    } else if (parent && call === 2) yield* action('agent_answer_subagent', { delegationId: question.payload.delegation,
      questionMessageId: question.messageId, text: 'Use Markdown.', timeoutMs: 30000 })
    else yield* final(parent ? 'Parent integrated the Markdown report.' : 'Child produced Markdown.')
  } }) }
  host = await h.openHost(spec, { clock, bindings })
  await host.submitTask('writer', 'Ask for missing information.')
  const waiting = (await host.run()).members[0].agent
  const originalChild = host.delegationReport().delegations[0].childSessionId
  assert.equal(waiting.waits[0].created.payload.result.descriptor.kind, 'user')
  await host.shutdown(); host = undefined
  host = await h.openHost(spec, { clock, bindings })
  assert.equal(childCalls, 1)
  await host.submitAnswer('writer', waiting.waits[0].reference, 'Markdown, please.')
  assert.equal(host.resume('writer')[0].status, 'resumed')
  assert.equal((await host.run()).members[0].agent.final.text, 'Parent integrated the Markdown report.')
  assert.equal(host.delegationReport().delegations[0].childSessionId, originalChild)
  assert.equal(host.delegationReport().unresolved, 0)
  assert.equal(childCalls, 2)
  process.stdout.write(JSON.stringify({ example: 'subagent-human-question', parentCalls, childCalls, restarted: true, closed: true }) + '\n')
} finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }

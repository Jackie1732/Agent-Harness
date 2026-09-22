import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { subagentConfig, clock, delegationRequest, action, final, protocolInput } from '../examples/subagent-fixture.mjs'
import { captureFileCommits, verifySubagentPrefixes } from './helpers/subagent-prefixes.mjs'

test('every parent/child commit and interrupted recovery prefix: progress, question, answer and result adoption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-full-trace-'))
  let host
  try {
    const config = await subagentConfig(root)
    let parentCalls = 0; let childCalls = 0
    const spec = h.resolveHostConfig(h.decodeHostConfig(config, root))
    const frames = await captureFileCommits(async () => {
      await h.initializeHost(spec, { clock })
      host = await h.openHost(spec, { clock, bindings: { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
        script: async function* (submission) {
          const parent = member.agentKey === config.members[0].agentKey
          const call = parent ? parentCalls++ : childCalls++
          yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'prefix' }
          if (parent && call === 0) yield* action('agent_spawn_subagent', delegationRequest())
          else if (!parent && call === 0) yield* action('agent_report_progress', { text: 'Evidence located.' })
          else if (!parent && call === 1) yield* action('agent_ask_parent', { question: 'Confirm evidence?', timeoutMs: 10000 })
          else if (parent && call === 1) {
            const question = protocolInput(submission, 'subagent-question')
            assert.ok(question)
            yield* action('agent_answer_subagent', { delegationId: question.payload.delegation, questionMessageId: question.messageId, text: 'Confirmed', timeoutMs: 30000 })
          } else yield* final(parent ? 'Reviewed.' : 'Verified.')
        },
      }) } })
      await host.submitTask(config.members[0].agentKey, 'Review evidence through a child')
      await host.run()
      assert.equal(host.delegationReport().unresolved, 0)
      await host.shutdown()
    })
    const actions = frames.filter(frame => frame.kind === 'event' && ['agent/action-settled', 'agent/turn-settled', 'subagent/protocol-recorded'].includes(frame.event.type))
      .map(frame => ({ type: frame.event.type, payload: frame.event.payload }))
    assert.equal(parentCalls, 3, JSON.stringify(actions)); assert.equal(childCalls, 3)
    await verifySubagentPrefixes('question-progress-result', config, frames, clock)
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
})

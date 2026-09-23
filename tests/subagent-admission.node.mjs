import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { SessionContext } from '../dist/context/session-context.js'
import { HostSubagents } from '../dist/host/subagents.js'
import { nodeHostTimer } from '../dist/host/timer.js'
import { subagentConfig, clock, delegationRequest, action, final, protocolInput } from '../examples/subagent-fixture.mjs'

test('new protocol maintenance yields while a child holds its committed model input before CP0', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-admission-'))
  const assemble = SessionContext.prototype.assembleAgent
  const next = HostSubagents.prototype.nextAction
  let host; let held = false; let release; let childAssemblies = 0; let scans = 0
  let parentCalls = 0; let childCalls = 0
  const gate = new Promise(resolve => { release = resolve })
  try {
    const config = await subagentConfig(root)
    const parentId = config.members[0].sessionId
    SessionContext.prototype.assembleAgent = async function (...args) {
      const result = await assemble.apply(this, args)
      if (result.kind === 'ready' && result.committed.stored.sessionId !== parentId && ++childAssemblies === 2) {
        held = true
        await gate
        held = false
      }
      return result
    }
    HostSubagents.prototype.nextAction = function () {
      const operation = next.call(this)
      if (held) {
        try {
          assert.equal(operation, undefined, 'new protocol actions must yield before Model CP0')
          assert.equal(parentCalls, 1, 'progress alone cannot start a parent model')
          if (++scans === 5) release()
        } catch (cause) { release(); throw cause }
      }
      return operation
    }
    const timer = { now: nodeHostTimer.now, wait: (ms, signal) => !held
      ? nodeHostTimer.wait(ms, signal) : new Promise(resolve => setImmediate(resolve)) }
    const spec = h.resolveHostConfig(h.decodeHostConfig(config, root))
    await h.initializeHost(spec, { clock })
    host = await h.openHost(spec, { clock, timer, bindings: { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
      script: async function* () {
        const parent = member.agentKey === config.members[0].agentKey
        const call = parent ? parentCalls++ : childCalls++
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'admission' }
        if (parent && call === 0) yield* action('agent_spawn_subagent', delegationRequest())
        else if (!parent && call === 0) yield* action('agent_report_progress', { text: 'Evidence located.' })
        else yield* final(parent ? 'Reviewed.' : 'Verified.')
      },
    }) } })
    await host.submitTask(config.members[0].agentKey, 'Review evidence')
    await host.run()
    assert.ok(scans >= 5)
    assert.equal(parentCalls, 2); assert.equal(childCalls, 2)
    assert.equal(host.delegationReport().unresolved, 0)
  } finally {
    release(); SessionContext.prototype.assembleAgent = assemble; HostSubagents.prototype.nextAction = next
    await host?.shutdown(); await rm(root, { recursive: true, force: true })
  }
})

test('a child question times out while the parent still waits for the user', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-late-answer-'))
  let host; let question; let parentCalls = 0; let childCalls = 0
    let now = clock.now()
  const mutableClock = { now: () => now }
  try {
    const config = await subagentConfig(root)
    config.members[0].profile.budget = { ...config.members[0].profile.budget, maxJsonNodes: 100000 }
    const spec = h.resolveHostConfig(h.decodeHostConfig(config, root))
    await h.initializeHost(spec, { clock: mutableClock })
    host = await h.openHost(spec, { clock: mutableClock, bindings: { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
      script: async function* (submission) {
        const parent = member.agentKey === config.members[0].agentKey
        const call = parent ? parentCalls++ : childCalls++
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'late-answer' }
        if (parent && call === 0) yield* action('agent_spawn_subagent', delegationRequest())
        else if (!parent && call === 0) yield* action('agent_ask_parent', { question: 'Which format?', timeoutMs: 10000 })
        else if (parent && call === 1) {
          question = protocolInput(submission, 'subagent-question')
          yield* action('agent_ask_user', { question: question.payload.question, timeoutMs: 30000 })
        } else if (parent && call === 2) yield* action('agent_answer_subagent', { delegationId: question.payload.delegation,
          questionMessageId: question.messageId, text: 'Markdown', timeoutMs: 10000 })
        else if (parent && call === 3) yield* action('agent_await_subagent', { delegationId: question.payload.delegation, timeoutMs: 10000 })
        else yield* final(parent ? 'Child timeout acknowledged.' : 'Unexpected child continuation.')
      },
    }) } })
    await host.submitTask(config.members[0].agentKey, 'Ask the user for a format')
    const waiting = (await host.run()).members[0].agent.waits.find(wait => wait.created.payload.result.descriptor.kind === 'user')
    assert.ok(waiting)
    now += 10001
    await host.run()
    assert.equal(parentCalls, 2); assert.equal(childCalls, 1)
    assert.equal(host.delegationReport().delegations[0].pendingQuestions, 0)
    await host.submitAnswer(config.members[0].agentKey, waiting.reference, 'Markdown')
    const run = await host.run()
    assert.equal(run.members[0].agent.final?.text, 'Child timeout acknowledged.', JSON.stringify({ run, delegations: host.delegationReport() }))
    assert.equal(childCalls, 1, 'a late answer cannot restart the terminal child')
    assert.equal(host.delegationReport().unresolved, 0, JSON.stringify(host.delegationReport()))
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
})

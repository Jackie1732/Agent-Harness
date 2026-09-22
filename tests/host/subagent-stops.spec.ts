import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost } from '../../src/index.js'
import type { AtomicHost, JsonObject } from '../../src/index.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { subagentHostConfig } from './subagent-fixture.js'

async function* action(name: string, args: unknown): AsyncGenerator<ModelFrame> {
  yield { kind: 'block-start', index: 0, block: 'tool-call', name, callId: 'control' }
  yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(args) }
  yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
}
it.each(['cancel', 'deadline', 'offline'] as const)('settles a waiting child after parent %s without reconstructing a business Provider', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-stop-'))
  let host: AtomicHost | undefined
  let now = Date.parse('2026-09-22T00:00:00Z'); const clock = { now: () => now }
  let children = 0; let parentCalls = 0; let childCalls = 0
  try {
    const raw = await subagentHostConfig(root)
    const member = (raw.members as JsonObject[])[0]!
    const config = { ...raw, members: [{ ...member, spec: { ...(member.spec as JsonObject),
      nativeActions: ['agent_spawn_subagent', 'agent_await_subagent', 'agent_answer_subagent', 'agent_ask_user'] } }] }
    const spec = resolveHostConfig(decodeHostConfig(config, root))
    await initializeHost(spec, { clock })
    host = await openHost(spec, { clock, bindings: { createModelProvider: member => {
      if (member.agentKey !== 'writer') children++
      return new ScriptedModelProvider({ ...member.model, script: async function* (): AsyncGenerator<ModelFrame> {
        const parent = member.agentKey === 'writer'
        const call = parent ? parentCalls++ : childCalls++
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'stop' }
        if (parent && call === 0) yield* action('agent_spawn_subagent', { templateKey: 'research', templateVersion: 1, task: 'Check evidence', materials: [],
          requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } })
        else if (!parent) yield* action('agent_ask_parent', { question: 'Which evidence?', timeoutMs: 10000 })
        else yield* action('agent_ask_user', { question: 'Please provide evidence', timeoutMs: 60000 })
      } })
    } } })
    await host.submitTask('writer', 'Delegate')
    await host.run()
    expect(childCalls).toBe(1); expect(parentCalls).toBe(2)
    const relation = host.delegationReport().delegations[0]!
    if (mode === 'cancel') await host.cancel('writer', relation.parentRoot)
    else if (mode === 'deadline') now += 60001
    else {
      await host.setMailboxOnline('writer', false, 'cancel')
      expect(children).toBe(1)
      await host.setMailboxOnline('writer', true)
      expect(host.resume('writer')).toMatchObject([{ status: 'resumed' }])
      await host.cancel('writer', relation.parentRoot)
    }
    await host.run()
    expect(host.delegationReport().delegations[0], JSON.stringify(host.delegationReport())).toMatchObject({ closed: true, executionReleased: true, adopted: false })
    expect(children).toBe(1); expect(childCalls).toBe(1)
    expect(host.delegationReport().delegations[0]!.childModelUsage).toMatchObject({ settled: 1, inputTokens: null, outputTokens: null })
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 40000)

import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost, FileSessionBackend, SessionRepository, hostRuntimeEventCatalog, parseSessionId, rebuildAssembly, createDeepSeekModelProvider, createAnthropicModelProvider } from '../../src/index.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { delegationClosure } from '../../src/subagent/closure.js'
import { subagentHostConfig } from './subagent-fixture.js'
import { hostSessionId } from './fixtures.js'

const clock = { now: () => Date.parse('2026-09-22T00:00:00Z') }

it.each([false, true])('runs and closes the complete delegation with child question = %s', async question => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-subagent-'))
  const spec = resolveHostConfig(decodeHostConfig(await subagentHostConfig(root), root))
  await initializeHost(spec, { clock })
  let parentCalls = 0
  let childCalls = 0
  const host = await openHost(spec, { clock, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    script: async function* (submission): AsyncGenerator<ModelFrame> {
      const parent = member.agentKey === 'writer'
      const call = parent ? parentCalls++ : childCalls++
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'test' }
      if (parent && call === 0) {
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'spawn', name: 'agent_spawn_subagent' }
        yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ templateKey: 'research', templateVersion: 1, task: 'Check the supplied evidence',
          materials: [{ label: 'evidence', text: '42' }], requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }) }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } else if (question && (!parent && call === 0 || parent && call === 1)) {
        const incoming = submission.request.messages.flatMap(message => message.content.filter(block => block.kind === 'text'))
          .map(block => { try { return JSON.parse(block.text) } catch { return null } }).find(value => value?.kind === 'subagent-question')
        const args = parent ? { delegationId: incoming.data.payload.delegation, questionMessageId: incoming.data.messageId, text: 'Use the supplied evidence', timeoutMs: 10000 }
          : { question: 'Which evidence should I use?', timeoutMs: 10000 }
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'question', name: parent ? 'agent_answer_subagent' : 'agent_ask_parent' }
        yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(args) }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } else {
        if (parent) expect(JSON.stringify(submission.request)).toContain('child evidence verified')
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: parent ? 'parent integrated evidence' : 'child evidence verified' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      }
    },
  }) } })
  try {
    await host.submitTask('writer', 'Delegate a bounded check')
    const report = await host.run()
    expect(report.members[0]?.agent.final, JSON.stringify(report)).toMatchObject({ text: 'parent integrated evidence' })
    expect(parentCalls).toBe(question ? 3 : 2); expect(childCalls).toBe(question ? 2 : 1)
  } finally { await host.shutdown() }
  const repository = new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: spec.storage.maxRecordBytes }), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
  try {
    const parent = await repository.open(parseSessionId(hostSessionId))
    const state = projectAgentSession(parent.snapshot())
    expect(state.roots).toHaveLength(1)
    expect(state.roots[0]?.outcome).toBe('completed')
    const cp = state.subagents.delegations[0]!
    const child = await repository.open(cp.payload.childSessionId)
    expect(child.header.parent).toBeUndefined()
    expect(projectAgentSession(child.snapshot()).roots).toHaveLength(1)
    expect(delegationClosure(state, cp.stored.eventId, parent.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known'))).toMatchObject({ closed: true, adopted: true })
    const options = { providerId: 'offline-check', endpoint: 'https://example.invalid/api', apiKey: 'offline-secret-sentinel',
      maxConcurrentExchanges: 1, streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 } }
    const providers = [createDeepSeekModelProvider(options), createAnthropicModelProvider(options)]
    try {
      for (const session of [parent, child]) for (const event of session.snapshot().history.at(-1)!.events.filter(item => item.stored.type === 'context/assembly-committed')) {
        const rebuilt = rebuildAssembly(session.snapshot(), event.stored.eventId)
        expect(rebuilt.kind).toBe('rebuilt')
        if (rebuilt.kind !== 'rebuilt') continue
        for (const provider of providers) expect(JSON.stringify(provider.prepare(rebuilt.request).submission)).not.toContain('offline-secret-sentinel')
      }
    } finally { for (const provider of providers) await provider.dispose() }
  } finally { await repository.dispose(); await rm(root, { recursive: true, force: true }) }
}, 30000)

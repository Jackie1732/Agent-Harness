import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { delegatedWorkflowHost } from './subagent-fixture.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'

it.each([false, true])('adopts a private Child result inside its work root with question = %s', async question => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-child-'))
  try {
    const base = await delegatedWorkflowHost(root)
    const spec = { ...base, scheduling: { ...base.scheduling, maxBatchesPerRun: question ? 1 : 200 } }
    const now = Date.now(), clock = { now: () => now }
    await initializeHost(spec, { clock })
    let parentCalls = 0, childCalls = 0
    const bindings: import('../../src/host/slot.js').HostRuntimeBindings = { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission): AsyncGenerator<ModelFrame> {
        const parent = member.agentKey === 'writer', child = member.agentKey !== 'writer' && member.agentKey !== 'reviewer'
        if (parent) parentCalls++
        if (child) childCalls++
        yield { kind: 'message-start', responseId: 'delegated-work', reportedModel: member.spec.target.model }
        if (parent && parentCalls === 1) {
          yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'spawn', name: 'agent_spawn_subagent' }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ templateKey: 'research', templateVersion: 1,
            task: 'Check the supplied evidence', materials: [{ label: 'evidence', text: 'local source' }],
            requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }) }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else if (question && (child && childCalls === 1 || parent && parentCalls === 2)) {
          const adopted = submission.request.messages.flatMap(message => message.content.filter(block => block.kind === 'text'))
            .map(block => { try { return JSON.parse(block.text) } catch { return null } }).find(value => value?.kind === 'subagent-question')
          yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'answer', name: parent ? 'agent_answer_subagent' : 'agent_ask_parent' }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(parent
            ? { delegationId: adopted.data.payload.delegation, questionMessageId: adopted.data.messageId, text: 'Use the supplied source', timeoutMs: 10000 }
            : { question: 'Which source?', timeoutMs: 10000 }) }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          if (parent) expect(JSON.stringify(submission.request)).toContain('private child evidence')
          if (!parent && !child) expect(JSON.stringify(submission.request)).toContain('integrated evidence')
          yield { kind: 'block-start', index: 0, block: 'text' }
          yield { kind: 'text-delta', index: 0, text: child ? 'private child evidence' : parent ? '{"text":"integrated evidence"}' : 'final accepted report' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } }) }
    let host = await openHost(spec, { clock, bindings })
    try {
      await host.workflow('research').resume({ requestKey: 'start' })
      if (question) {
        for (let batch = 0; batch < 100 && childCalls === 0; batch++) await host.run()
        expect(childCalls).toBe(1); expect(parentCalls).toBe(1)
        await host.shutdown({ mode: 'drain' })
        host = await openHost({ ...spec, scheduling: { ...spec.scheduling, maxBatchesPerRun: 200 } }, { clock, bindings })
        await host.run()
        expect(childCalls).toBe(1); expect(parentCalls).toBe(1)
        await host.workflow('research').resume({ requestKey: 'resume-owned-child' })
      }
      await host.run()
      expect(host.workflow('research').report()).toMatchObject({ state: 'completed', closed: true, counts: { accepted: 2, assignments: 2 } })
      expect(host.delegationReport()).toMatchObject({ count: 1, delegations: [{ closed: true, adopted: true, grant: { models: 2 } }] })
      const writer = host.report().members.find(member => member.agentKey === 'writer')!
      expect(writer.agent.roots).toHaveLength(1)
      expect(writer.agent.roots[0]).toMatchObject({ limit: { models: 8 }, budget: { models: question ? 5 : 4 } })
      expect(parentCalls).toBe(question ? 3 : 2); expect(childCalls).toBe(question ? 2 : 1)
    } finally { await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)

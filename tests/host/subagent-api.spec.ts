import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost, formatSessionAddress, parseSessionId } from '../../src/index.js'
import type { AtomicHost, ParentSubagents, JsonObject, DelegationRequest } from '../../src/index.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { subagentHostConfig } from './subagent-fixture.js'
import { hostSessionId } from './fixtures.js'

it('binds external control to one parent, snapshots idempotent requests and observes without driving execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-parent-api-'))
  const clock = { now: () => Date.parse('2026-09-22T00:00:00Z') }
  let host: AtomicHost | undefined; let parent: ParentSubagents | undefined; let id: import('../../src/index.js').SessionEventId
  let calls = 0; let childCalls = 0
  try {
    const base = await subagentHostConfig(root); const member = (base.members as JsonObject[])[0]!
    const spec = resolveHostConfig(decodeHostConfig({ ...base, members: [{ ...member, spec: { ...(member.spec as JsonObject),
      nativeActions: [...((member.spec as JsonObject).nativeActions as string[]), 'agent_ask_user'] } }] }, root))
    await initializeHost(spec, { clock })
    host = await openHost(spec, { clock, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (): AsyncGenerator<ModelFrame> {
        const isParent = member.agentKey === 'writer'; const call = isParent ? calls++ : childCalls++
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'api' }
        if (isParent && call < 2) {
          if (call === 1) await expect(parent!.wait(id, { until: 'business' })).rejects.toMatchObject({ code: 'HOST_REENTRANT_WAIT' })
          yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'wait', name: call === 0 ? 'agent_ask_user' : 'agent_await_subagent' }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(call === 0 ? { question: 'Start?', timeoutMs: 30000 } : { delegationId: id, timeoutMs: 30000 }) }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'integrated' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      },
    }) } })
    await host.submitTask('writer', 'Wait for authorization')
    const waiting = (await host.run()).members[0]!.agent
    parent = host.bindParent(formatSessionAddress(parseSessionId(hostSessionId)), waiting.roots[0]!.id)
    const request: DelegationRequest = { templateKey: 'research', templateVersion: 1, task: 'Check', materials: [],
      requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }
    const pending = parent.spawn('same-key', request)
    const duplicate = parent.spawn('same-key', structuredClone(request))
    const receipt = await pending; id = receipt.delegationId
    expect(await duplicate).toEqual(receipt)
    await expect(parent.spawn('same-key', { ...request, task: 'Changed' })).rejects.toMatchObject({ code: 'SUBAGENT_REQUEST_CONFLICT' })
    expect(childCalls).toBe(0)
    const abort = new AbortController()
    const observation = parent.wait(id, { until: 'closed', signal: abort.signal })
    abort.abort(new Error('observer-left'))
    await expect(observation).rejects.toThrow('observer-left')
    expect(parent.inspect(id).businessResolved).toBe(false)
    await host.run()
    expect(await parent.wait(id, { until: 'business' })).toMatchObject({ resultAvailable: true, adopted: false, closed: false })
    expect(childCalls).toBe(1)
    await host.submitAnswer('writer', waiting.waits[0]!.reference, 'Proceed')
    await host.run()
    expect(await parent.wait(id, { until: 'closed' })).toMatchObject({ adopted: true })
    expect(calls).toBe(3); expect(childCalls).toBe(1)
    expect(await parent.spawn('same-key', request)).toEqual(receipt)
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 30000)

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost, formatSessionAddress, parseSessionId } from '../../src/index.js'
import type { AtomicHost, JsonObject } from '../../src/index.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { subagentHostConfig } from './subagent-fixture.js'
import { hostSessionId } from './fixtures.js'

const clock = { now: () => Date.parse('2026-09-22T00:00:00Z') }
const request = { templateKey: 'research', templateVersion: 1, task: 'Inspect the evidence', materials: [],
  requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }

async function until(host: AtomicHost, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 150 && !predicate(); i++) await host.run()
  expect(predicate(), JSON.stringify(host.delegationReport())).toBe(true)
}

it.each(['before-child', 'question'] as const)('reopens %s with the reserved child identity and explicit resumption', async point => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-resume-'))
  let host: AtomicHost | undefined
  let parentCalls = 0; let childCalls = 0; let childProviders = 0
  try {
    const base = await subagentHostConfig(root)
    const config = { ...base, scheduling: { ...(base.scheduling as JsonObject), maxBatchesPerRun: 1 } }
    const spec = resolveHostConfig(decodeHostConfig(config, root))
    await initializeHost(spec, { clock })
    const bindings = { createModelProvider: (member: Parameters<NonNullable<import('../../src/host/slot.js').HostRuntimeBindings['createModelProvider']>>[0]) => {
      if (member.agentKey !== 'writer') childProviders++
      return new ScriptedModelProvider({ ...member.model, script: async function* (submission): AsyncGenerator<ModelFrame> {
        const parent = member.agentKey === 'writer'; const call = parent ? parentCalls++ : childCalls++
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'test' }
        let name: string | undefined; let args: unknown
        if (parent && call === 0) { name = 'agent_spawn_subagent'; args = request }
        else if (!parent && call === 0 && point === 'question') { name = 'agent_ask_parent'; args = { question: 'Which evidence?', timeoutMs: 10000 } }
        else if (parent && call === 1 && point === 'question') {
          const incoming = submission.request.messages.flatMap(message => message.content.filter(block => block.kind === 'text'))
            .map(block => { try { return JSON.parse(block.text) } catch { return null } }).find(value => value?.kind === 'subagent-question')
          name = 'agent_answer_subagent'; args = { delegationId: incoming.data.payload.delegation, questionMessageId: incoming.data.messageId, text: 'Use the supplied evidence', timeoutMs: 10000 }
        }
        if (name !== undefined) {
          yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'action', name }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(args) }; yield { kind: 'block-end', index: 0 }
          yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: parent ? 'integrated' : 'verified' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } })
    } }
    host = await openHost(spec, { clock, bindings })
    await host.submitTask('writer', 'Delegate')
    await until(host, () => point === 'before-child' ? host!.delegationReport().count === 1 : childCalls === 1)
    const childId = host.delegationReport().delegations[0]!.childSessionId
    await host.shutdown(); host = undefined
    const countBefore = childProviders
    host = await openHost(spec, { clock, bindings })
    expect(childProviders).toBe(countBefore)
    expect(host.delegationReport().delegations[0]).toMatchObject({ childSessionId: childId, suspended: true })
    await host.run()
    expect(childProviders).toBe(countBefore)
    expect(host.resume('writer')).toMatchObject([{ status: 'resumed' }])
    await until(host, () => host!.delegationReport().delegations[0]!.closed)
    expect(host.delegationReport().delegations[0]).toMatchObject({ childSessionId: childId, adopted: true })
    expect(childCalls).toBe(point === 'question' ? 2 : 1)
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 40000)

it('cancels before child materialization without acquiring a child Provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-cancel-'))
  let host: AtomicHost | undefined
  let children = 0
  try {
    const base = await subagentHostConfig(root)
    const config = { ...base, scheduling: { ...(base.scheduling as JsonObject), maxBatchesPerRun: 1 } }
    const spec = resolveHostConfig(decodeHostConfig(config, root))
    await initializeHost(spec, { clock })
    host = await openHost(spec, { clock, bindings: { createModelProvider: member => {
      if (member.agentKey !== 'writer') children++
      return new ScriptedModelProvider({ ...member.model, script: async function* (): AsyncGenerator<ModelFrame> {
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'cancel' }
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'spawn', name: 'agent_spawn_subagent' }
        yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(request) }; yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: 'tool-calls' }
      } })
    } } })
    await host.submitTask('writer', 'Delegate')
    await until(host, () => host!.delegationReport().count === 1)
    const relation = host.delegationReport().delegations[0]!
    const parent = host.bindParent(formatSessionAddress(parseSessionId(hostSessionId)), relation.parentRoot)
    await host.cancel('writer', relation.parentRoot)
    await until(host, () => parent.inspect(relation.delegationId).closed)
    expect(children).toBe(0)
    expect(parent.inspect(relation.delegationId)).toMatchObject({ adopted: false, inputDisposed: true, executionReleased: true })
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost, ScriptedModelProvider, formatSessionAddress, parseSessionId } from '../../src/index.js'
import type { AtomicHost, DelegationRequest, HostTimer, JsonObject, ModelFrame } from '../../src/index.js'
import type { HostRuntimeBindings } from '../../src/host/slot.js'
import { subagentHostConfig } from './subagent-fixture.js'
import { hostConfig } from './fixtures.js'

export const controlClock = { now: () => Date.parse('2026-09-22T00:00:00Z') }
export const controlRequest: DelegationRequest = { templateKey: 'research', templateVersion: 1, task: 'Check evidence', materials: [],
  requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }

/** Real file-backed parent roots wait independently; accepted children start only when the caller drives the Host. */
export async function waitingDelegations(options: { count?: number; timer?: HostTimer; batches?: number; childResponse?: string; clock?: typeof controlClock } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'subagent-control-'))
  let host: AtomicHost | undefined
  let childCalls = 0
  const clock = options.clock ?? controlClock
  const bindings: HostRuntimeBindings = { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    script: async function* (): AsyncGenerator<ModelFrame> {
      const parent = member.agentKey === 'writer'
      if (!parent) childCalls++
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'control' }
      if (!parent && options.childResponse !== undefined) {
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: options.childResponse }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        return
      }
      yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'question', name: parent ? 'agent_ask_user' : 'agent_ask_parent' }
      yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ question: 'Which evidence?', timeoutMs: parent ? 60000 : 10000 }) }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
    },
  }) }
  try {
    const raw = await subagentHostConfig(root)
    const parent = (raw.members as JsonObject[])[0]!
    const legacy = { ...(hostConfig(root).members as JsonObject[])[0]!, agentKey: 'observer', sessionId: '70000000-0000-4000-8000-000000000109' }
    const config: JsonObject = { ...raw, members: [{ ...parent, spec: { ...(parent.spec as JsonObject),
      nativeActions: [...((parent.spec as JsonObject).nativeActions as string[]), 'agent_ask_user'],
      limits: { ...((parent.spec as JsonObject).limits as JsonObject), maxManagementPerRun: 1 } } }, legacy],
    routes: [...raw.routes as JsonObject[], { memberKey: 'observer', ownerHost: raw.hostKey!, origin: null, serverName: null }],
    scheduling: { ...(raw.scheduling as JsonObject), scanIntervalMs: 60000, maxBatchesPerRun: options.batches ?? 256 } }
    const spec = resolveHostConfig(decodeHostConfig(config, root))
    await initializeHost(spec, { clock })
    host = await openHost(spec, { clock, bindings, ...(options.timer === undefined ? {} : { timer: options.timer }) })
    const count = options.count ?? 2
    for (let i = 0; i < count; i++) await host.submitTask('writer', `Question ${i}`)
    for (let i = 0; i < 20 && host.report().members[0]!.agent.waits.length < count; i++) await host.run()
    const roots = host.report().members[0]!.agent.roots
    if (roots.length !== count || host.report().members[0]!.agent.waits.length !== count) throw new Error('parent fixture did not wait')
    const parents = roots.map(item => host!.bindParent(formatSessionAddress(parseSessionId(spec.members[0]!.sessionId)), item.id))
    const receipts = []
    for (const parent of parents) receipts.push(await parent.spawn('same-spawn-key', controlRequest))
    return { root, config, spec, host, bindings, parents, receipts, childCalls: () => childCalls,
      close: async () => { await host!.shutdown(); await rm(root, { recursive: true, force: true }) } }
  } catch (cause) { await host?.shutdown(); await rm(root, { recursive: true, force: true }); throw cause }
}

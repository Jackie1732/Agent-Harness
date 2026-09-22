import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost } from '../../src/index.js'
import type { AtomicHost, JsonObject } from '../../src/index.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { subagentHostConfig } from './subagent-fixture.js'

it.each(['template', 'disabled', 'capability', 'grant'] as const)('rechecks %s changes before resuming an accepted obligation', async change => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-authority-'))
  const clock = { now: () => Date.parse('2026-09-22T00:00:00Z') }
  let host: AtomicHost | undefined; let acquired = 0
  try {
    const raw = await subagentHostConfig(root)
    const config = { ...raw, scheduling: { ...(raw.scheduling as JsonObject), maxBatchesPerRun: 1 } }
    const spec = resolveHostConfig(decodeHostConfig(config, root))
    await initializeHost(spec, { clock })
    const bindings = { createModelProvider: (member: Parameters<NonNullable<import('../../src/host/slot.js').HostRuntimeBindings['createModelProvider']>>[0]) => {
      acquired++
      return new ScriptedModelProvider({ ...member.model, script: async function* (): AsyncGenerator<ModelFrame> {
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'admission' }
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'spawn', name: 'agent_spawn_subagent' }
        yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ templateKey: 'research', templateVersion: 1, task: 'Check', materials: [],
          requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }) }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } })
    } }
    host = await openHost(spec, { clock, bindings }); await host.submitTask('writer', 'Delegate')
    for (let i = 0; i < 10 && host.delegationReport().count === 0; i++) await host.run()
    const relation = host.delegationReport().delegations[0]!
    await host.shutdown(); host = undefined; acquired = 0
    const domain = raw.subagents as JsonObject
    const parent = (domain.parents as JsonObject[])[0]!
    const changed = { ...config, subagents: change === 'disabled' ? { kind: 'disabled' } : { ...domain,
      templates: change === 'template' ? (domain.templates as JsonObject[]).map(template => ({ ...template,
        model: { ...(template.model as JsonObject), text: 'changed template body' } })) : domain.templates,
      parents: [{ ...parent, ...(change === 'capability' ? { capabilities: { ...(parent.capabilities as JsonObject), models: [] } }
        : change === 'grant' ? { maxGrant: { ...(parent.maxGrant as JsonObject), models: 0 } } : {}) }] } }
    if (change === 'disabled') {
      expect(() => resolveHostConfig(decodeHostConfig(changed, root))).toThrow('invalid-agent-spec')
      expect(acquired).toBe(0)
      return
    }
    const next = resolveHostConfig(decodeHostConfig(changed, root))
    if (change === 'template') {
      await expect(openHost(next, { clock, bindings })).rejects.toMatchObject({ code: 'HOST_BINDING_CONFLICT' })
      expect(acquired).toBe(0)
    } else {
      host = await openHost(next, { clock, bindings })
      expect(acquired).toBe(1)
      expect(host.resume('writer')).toMatchObject([{ status: 'blocked' }])
      await host.run(); expect(acquired).toBe(1)
      await host.cancel('writer', relation.parentRoot)
      expect(host.resume('writer')).toMatchObject([{ status: 'resumed' }])
      for (let i = 0; i < 100 && !host.delegationReport().delegations[0]!.closed; i++) await host.run()
      expect(host.delegationReport().delegations[0]!.closed).toBe(true)
      expect(acquired).toBe(1)
    }
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 30000)

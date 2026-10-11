import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import type { ResolvedHostLocalMember } from '../../src/host/config.js'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { inspectHost } from '../../src/host/inspection.js'
import { createHostModelProvider } from '../../src/host/model-factory.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import type { AgentActionReference } from '../../src/agent/contract.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import type { SessionEventId } from '../../src/session/ids.js'
import { parseSessionId } from '../../src/session/ids.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import type { WorkflowObservation } from '../../src/protocol/results.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { hostConfig } from './fixtures.js'
import { runnableWorkflowConfig, runnableWorkflowHost } from '../workflow/host-fixture.js'

function offlineMembers(config: JsonObject): JsonObject {
  return { ...config, members: (config.members as readonly JsonObject[]).map(member => ({ ...member, enabled: false })) }
}

it('settles coordinator cancellation through finite runs when all execution members are offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-offline-coordinator-'))
  const configured = runnableWorkflowConfig(directory)
  const spec = resolveHostConfig(decodeHostConfig({ ...offlineMembers(configured),
    scheduling: { ...(configured.scheduling as JsonObject), maxBatchesPerRun: 1 },
  }, directory))
  const createModelProvider = vi.fn((member: ResolvedHostLocalMember) => createHostModelProvider(member.model, {}))
  try {
    await initializeHost(spec)
    const host = await openHost(spec, { bindings: { createModelProvider } })
    try {
      const workflow = host.workflow('research')
      await workflow.cancel({ requestKey: 'cancel-with-no-online-peers' })
      let maintenance = 0
      for (let batch = 0; batch < 8 && !workflow.report().closed; batch++) {
        const run = await host.run()
        expect(run.batches).toBeLessThanOrEqual(1)
        expect(run.businessRuns).toBe(0)
        expect(run.deliveryAttempts).toBe(0)
        expect(run.counts.members).toBe(2)
        maintenance += run.maintenanceRuns
      }
      expect(workflow.report()).toMatchObject({ state: 'cancelled', settled: true, closed: true, counts: { assignments: 0 } })
      expect(maintenance).toBeGreaterThan(0)
      const before = await host.read().events({ kind: 'workflow', workflowKey: 'research' }, { maxEvents: 100 })
      expect(before.events.map(event => event.type)).toEqual(expect.arrayContaining(['workflow/stopped', 'workflow/terminal', 'workflow/closed']))
      expect(await host.run()).toMatchObject({ batches: 0, stoppedBy: 'quiescent' })
      const after = await host.read().events({ kind: 'workflow', workflowKey: 'research' }, { maxEvents: 100 })
      expect(after.through).toBe(before.through)
      expect(createModelProvider).not.toHaveBeenCalled()
    } finally { await host.shutdown({ mode: 'drain' }) }
    const reopened = await openHost(spec, { bindings: { createModelProvider } })
    try {
      expect(reopened.workflow('research').report()).toMatchObject({ state: 'cancelled', settled: true, closed: true })
      expect(await reopened.run()).toMatchObject({ batches: 0, stoppedBy: 'quiescent' })
      expect(createModelProvider).not.toHaveBeenCalled()
    } finally { await reopened.shutdown({ mode: 'drain' }) }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30000)

it('runs reattached ordinary work and a Workflow after scans with no execution members', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-offline-reattach-'))
  const spec = resolveHostConfig(decodeHostConfig(offlineMembers(runnableWorkflowConfig(directory)), directory))
  const createModelProvider = vi.fn((member: ResolvedHostLocalMember) => createHostModelProvider(member.model, {}))
  try {
    await initializeHost(spec)
    const host = await openHost(spec, { bindings: { createModelProvider } })
    try {
      expect(await host.run()).toMatchObject({ batches: 0, stoppedBy: 'quiescent' })
      expect(await host.run()).toMatchObject({ batches: 0, stoppedBy: 'quiescent' })
      expect(createModelProvider).not.toHaveBeenCalled()
      await host.setMailboxOnline('writer', true)
      await host.setMailboxOnline('reviewer', true)
      expect(createModelProvider).toHaveBeenCalledTimes(2)
      host.resume('writer'); host.resume('reviewer')
      await host.submitTask('writer', 'Ordinary task after reattachment')
      const ordinary = await host.run()
      expect(ordinary.businessRuns).toBe(1)
      expect(host.read().agent('writer').report.roots[0]).toMatchObject({ outcome: 'completed' })
      const workflow = host.workflow('research')
      await workflow.resume({ requestKey: 'resume-after-empty-scans' })
      const run = await host.run()
      expect(run.businessRuns).toBe(2)
      expect(workflow.report()).toMatchObject({ state: 'completed', settled: true, closed: true,
        counts: { assignments: 2, accepted: 2 }, usage: { modelCalls: 2 } })
      expect(createModelProvider.mock.calls.length).toBeGreaterThan(2)
    } finally { await host.shutdown({ mode: 'drain' }) }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30000)

it('keeps an ordinary all-offline Host quiescent without acquiring Providers or appending events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-offline-ordinary-'))
  const spec = resolveHostConfig(decodeHostConfig(offlineMembers(hostConfig(directory)), directory))
  const createModelProvider = vi.fn((member: ResolvedHostLocalMember) => createHostModelProvider(member.model, {}))
  try {
    await initializeHost(spec)
    const host = await openHost(spec, { bindings: { createModelProvider } })
    try {
      const before = await host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 100 })
      for (let run = 0; run < 2; run++) expect(await host.run()).toMatchObject({ batches: 0, businessRuns: 0,
        maintenanceRuns: 0, deliveryAttempts: 0, stoppedBy: 'quiescent', counts: { members: 1 } })
      const after = await host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 100 })
      expect(after.through).toBe(before.through)
      expect(createModelProvider).not.toHaveBeenCalled()
    } finally { await host.shutdown({ mode: 'drain' }) }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.each([{ label: 'all', disabled: ['writer', 'reviewer'] }, { label: 'one', disabled: ['writer'] }])('keeps closed Workflow history readable with $label execution members disabled', async ({ disabled }) => {
  const directory = await mkdtemp(join(tmpdir(), 'host-offline-history-'))
  const config = runnableWorkflowConfig(directory)
  const spec = resolveHostConfig(decodeHostConfig(config, directory))
  try {
    await initializeHost(spec)
    const first = await openHost(spec)
    let before!: WorkflowObservation
    try {
      await first.workflow('research').resume({ requestKey: 'complete-original' })
      await first.run()
      before = first.read().workflow('research')
      expect(before).toMatchObject({ state: 'completed', closed: true, work: [{ execution: 'released' }, { execution: 'released' }],
        counts: { assignments: 2, accepted: 2 }, usage: { modelCalls: 2 } })
    } finally { await first.shutdown({ mode: 'drain' }) }
    const partial = resolveHostConfig(decodeHostConfig({ ...config,
      members: (config.members as readonly JsonObject[]).map(member => ({ ...member, enabled: !disabled.includes(member.agentKey as string) })),
    }, directory))
    const createModelProvider = vi.fn((member: ResolvedHostLocalMember) => createHostModelProvider(member.model, {}))
    const prepare = vi.spyOn(ScriptedModelProvider.prototype, 'prepare')
    try {
      const reopened = await openHost(partial, { bindings: { createModelProvider } })
      try {
        const restored = reopened.read().workflow('research')
        expect(restored).toMatchObject({ state: 'completed', settled: true, closed: true, recoveryRequired: false,
          work: before.work, usage: before.usage, cuts: before.cuts })
        expect(reopened.workflow('research').report().work).toEqual(before.work)
        for (let run = 0; run < 2; run++) expect(await reopened.run()).toMatchObject({ batches: 0, businessRuns: 0, stoppedBy: 'quiescent' })
        expect(reopened.read().workflow('research').cuts).toEqual(before.cuts)
        expect(prepare).not.toHaveBeenCalled()
        expect(createModelProvider.mock.calls.map(([member]) => member.agentKey)).toEqual(disabled.length === 2 ? [] : ['reviewer'])
      } finally { await reopened.shutdown() }
      expect(prepare).not.toHaveBeenCalled()
      const reattached = await openHost(partial, { bindings: { createModelProvider } })
      try {
        await reattached.setMailboxOnline('writer', true)
        reattached.resume('writer')
        await reattached.submitTask('writer', 'New ordinary work after restoring history')
        expect((await reattached.run()).businessRuns).toBe(1)
        expect(reattached.read().agent('writer').report.roots.at(-1)).toMatchObject({ outcome: 'completed', source: { kind: 'ordinary' } })
        expect(reattached.read().workflow('research')).toMatchObject({ state: 'completed', closed: true, work: before.work, usage: before.usage })
      } finally { await reattached.shutdown() }
    } finally { prepare.mockRestore() }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30000)

it.each(['reattach-answer', 'offline-cancel'] as const)('restores an offline participant user wait before %s', async continuation => {
  const directory = await mkdtemp(join(tmpdir(), 'host-offline-wait-'))
  const tick = Date.now(), clock = { now: () => tick }
  try {
    const base = runnableWorkflowHost(directory)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('Workflow fixture required')
    const entry = base.workflows.definitions[0]!, node = entry.definition.nodes[0]!
    const grant = { models: 2, steps: 2, tools: 0, messages: 0, waits: 1, outputTokens: 512 }
    const members = base.members.map(member => {
      if (member.kind !== 'local' || member.spec.protocolVersion !== 3) throw new Error('Local Workflow participant required')
      return { ...member, spec: { ...member.spec, budget: grant,
        workflow: { kind: 'participant' as const, toolNames: [], resourceIds: [], nativeActions: ['agent_ask_user' as const] } },
        model: { ...member.model, runnerLimits: { ...member.model.runnerLimits, maxToolCalls: 1 } } }
    })
    const definition = decodeWorkflowDefinition({ ...entry.definition,
      roster: entry.definition.roster.map(peer => ({ ...peer, budgetCeiling: grant,
        ...workflowMemberFingerprints(members.find(member => member.agentKey === peer.memberKey)!) })),
      nodes: [{ ...node, attempts: [{ ...node.attempts[0]!, workerGrant: grant, nativeActions: ['agent_ask_user'] }] }],
      requiredOutputs: [node.nodeKey], communication: { ask: [], groups: [], disclosures: [{ nodeKey: node.nodeKey, recipients: ['coordinator'] }] },
      budget: grant })
    const spec = { ...base, members, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    let calls = 0
    const createModelProvider = vi.fn((member: ResolvedHostLocalMember) => new ScriptedModelProvider({ ...member.model,
      script: async function* (): AsyncGenerator<ModelFrame> {
        calls++
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: `offline-wait-${calls}` }
        if (calls === 1) {
          yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'ask' }
          yield { kind: 'arguments-delta', index: 0, text: '{"question":"Confirm?","timeoutMs":60000}' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          yield { kind: 'block-start', index: 0, block: 'text' }
          yield { kind: 'text-delta', index: 0, text: '{"text":"accepted after confirmation"}' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } }))
    await initializeHost(spec, { clock })
    const first = await openHost(spec, { clock, bindings: { createModelProvider } })
    let wait!: AgentActionReference, root!: SessionEventId
    let cuts!: WorkflowObservation['cuts']
    try {
      await first.workflow('research').resume({ requestKey: 'begin' }); await first.run()
      const writer = first.read().agent('writer')
      wait = writer.report.waits[0]!.reference; root = writer.report.roots[0]!.id
      await first.workflow('research').pause({ requestKey: 'pause-at-wait' }); await first.run()
      cuts = first.read().workflow('research').cuts
      expect(calls).toBe(1)
    } finally { await first.shutdown({ mode: 'drain' }) }
    createModelProvider.mockClear()
    const partial = { ...spec, members: members.map(member => ({ ...member, enabled: member.agentKey !== 'writer' })) }
    const reopened = await openHost(partial, { clock, bindings: { createModelProvider } })
    try {
      expect(createModelProvider.mock.calls.map(([member]) => member.agentKey)).toEqual(['reviewer'])
      expect(reopened.read().workflow('research')).toMatchObject({ state: 'paused', closed: false, recoveryRequired: false,
        cuts, work: [{ root, outcome: null, pendingWaits: 1, execution: 'active' }], usage: { modelCalls: 1 } })
      expect(reopened.read().agent('writer')).toMatchObject({ mailbox: 'known-offline', recoveryRequired: false,
        report: { waits: [{ reference: wait, settled: null }] } })
      expect(await reopened.run()).toMatchObject({ batches: 0, businessRuns: 0, stoppedBy: 'quiescent' })
      expect(reopened.read().workflow('research').cuts).toEqual(cuts)
      expect(calls).toBe(1)
      if (continuation === 'offline-cancel') {
        await reopened.workflow('research').cancel({ requestKey: 'cancel-original-offline' })
        expect((await reopened.run()).businessRuns).toBe(0)
        expect(reopened.read().workflow('research')).toMatchObject({ state: 'cancelled', closed: false,
          counts: { pendingOutbox: 1 }, usage: { modelCalls: 1 } })
        expect(createModelProvider.mock.calls.map(([member]) => member.agentKey)).toEqual(['reviewer'])
        expect(calls).toBe(1)
      } else {
        await reopened.setMailboxOnline('writer', true); reopened.resume('writer')
        await reopened.workflow('research').resume({ requestKey: 'continue-original' })
        await reopened.submitAnswer('writer', wait, 'Confirmed')
        await reopened.run()
        expect(reopened.read().workflow('research')).toMatchObject({ state: 'completed', closed: true, recoveryRequired: false,
          work: [{ root, outcome: 'completed', execution: 'released' }], counts: { assignments: 1, accepted: 1 }, usage: { modelCalls: 2 } })
        expect(reopened.read().agent('writer').report.roots).toHaveLength(1)
        expect(calls).toBe(2)
      }
    } finally { await reopened.shutdown() }
    if (continuation === 'offline-cancel') {
      const inspected = await inspectHost(partial, { protocolVersion: 3, clock })
      expect(inspected.recovery.pending).toEqual([])
      expect(inspected.members.find(member => member.agentKey === 'writer')!.report).toMatchObject({
        roots: [{ id: root, outcome: 'cancelled' }], counts: { pendingWaits: 0 } })
      expect(inspected.workflows.reports[0]).toMatchObject({ state: 'cancelled', closed: false,
        work: [{ root, outcome: 'cancelled', execution: 'release-pending' }], counts: { pendingOutbox: 1 } })
      const repository = new SessionRepository({ backend: new FileSessionBackend(partial.storage), catalog: hostRuntimeEventCatalog,
        maxLineageDepth: partial.storage.maxLineageDepth, clock })
      try {
        const snapshot = await repository.read(parseSessionId(members.find(member => member.agentKey === 'writer')!.sessionId))
        const state = projectAgentSession(snapshot)
        expect(state.waits.find(item => item.reference.eventId === wait.eventId && item.reference.index === wait.index)).toMatchObject({
          reference: wait, settled: { payload: { outcome: 'cancelled' } } })
      } finally { await repository.dispose() }
      expect(createModelProvider.mock.calls.map(([member]) => member.agentKey)).toEqual(['reviewer'])
      expect(calls).toBe(1)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30000)

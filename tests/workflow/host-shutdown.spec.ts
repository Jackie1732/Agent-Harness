import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { delegatedWorkflowHost } from './subagent-fixture.js'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { SessionRepository } from '../../src/session/repository.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { parseSessionId } from '../../src/session/ids.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'

it.each(['drain', 'cancel', 'upgrade', 'work-cancel', 'control-failure', 'offline-cancel'] as const)('preserves root ownership during %s', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-shutdown-'))
  let failControl = false
  const openWriter = FileSessionBackend.prototype.openWriter
  const spy = vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id) {
    const writer = await openWriter.call(this, id)
    return { ...writer, append: async (position, event) => {
      if (failControl && event.type === 'workflow/control-requested') { failControl = false; throw new Error('coordinator write failed') }
      return writer.append(position, event)
    } }
  })
  try {
    const base = await delegatedWorkflowHost(directory)
    const first = base.workflows.definitions[0]!
    const independent = decodeWorkflowDefinition({ ...first.definition, workflowKey: 'independent',
      coordinator: 'ah-session:87000000-0000-4000-8000-000000000009', requiredOutputs: ['write'],
      communication: { ask: [], groups: [], disclosures: [{ nodeKey: 'write', recipients: ['coordinator'] }] },
      nodes: [{ ...first.definition.nodes[1], dependencies: [], inputs: [], inputSchema: first.definition.nodes[0]!.inputSchema }] })
    const spec = mode !== 'work-cancel' ? base : { ...base, workflows: { ...base.workflows,
      definitions: [...base.workflows.definitions, { sessionId: '87000000-0000-4000-8000-000000000009', definition: independent }] } }
    const now = Date.now(), clock = { now: () => now }
    let parents = 0, children = 0
    await initializeHost(spec, { clock })
    const bindings: import('../../src/host/slot.js').HostRuntimeBindings = { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (): AsyncGenerator<ModelFrame> {
        const parent = member.agentKey === 'writer'
        if (parent) parents++
        else if (member.agentKey !== 'reviewer') children++
        yield { kind: 'message-start', responseId: 'waiting-child', reportedModel: member.spec.target.model }
        const name = parent ? parents === 1 ? 'agent_spawn_subagent' : 'agent_ask_user' : member.agentKey === 'reviewer' ? 'agent_ask_user' : 'agent_ask_parent'
        const args = name === 'agent_spawn_subagent' ? { templateKey: 'research', templateVersion: 1,
          task: 'Check evidence', materials: [], requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }
          : { question: 'Which evidence?', timeoutMs: parent ? 60000 : 10000 }
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: name, name }
        yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(args) }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } }) }
    let host = await openHost(spec, { clock, bindings })
    try {
      await host.workflow('research').resume({ requestKey: 'start' })
      if (mode === 'work-cancel') await host.workflow('independent').resume({ requestKey: 'start-independent' })
      await host.run()
      expect(parents).toBe(2); expect(children).toBe(1)
      if (mode === 'cancel') {
        await host.shutdown({ mode: 'drain' })
        host = await openHost(spec, { clock, bindings })
        expect(host.delegationReport().delegations[0]!.suspended).toBe(true)
      }
      if (mode === 'work-cancel') {
        await host.workflow('research').cancel({ requestKey: 'cancel-only-research' }); await host.run()
        expect(host.workflow('research').report()).toMatchObject({ state: 'cancelled', closed: true })
        expect(host.delegationReport().delegations[0]).toMatchObject({ closed: true, adopted: false })
        expect(host.report().members.find(member => member.agentKey === 'reviewer')!.agent.roots[0]!.outcome).toBeNull()
        expect(host.workflow('independent').report()).toMatchObject({ state: 'running', settled: false })
      }
      const observed = host.workflow('research').wait({ until: 'closed', timeoutMs: 60000 })
      if (mode === 'offline-cancel') await host.setMailboxOnline('writer', false)
      failControl = mode === 'control-failure'
      const closing = host.shutdown({ mode: ['cancel', 'control-failure', 'offline-cancel'].includes(mode) ? 'cancel' : 'drain' })
      if (mode === 'upgrade') expect(host.shutdown({ mode: 'cancel' })).toBe(closing)
      if (mode === 'control-failure') await expect(closing).rejects.toMatchObject({ code: 'HOST_CLEANUP_FAILED' })
      else await closing
      expect(await observed).toMatchObject({ status: 'host-closed' })
      expect(host.status).toBe(mode === 'control-failure' ? 'failed' : 'stopped')
      expect(parents).toBe(2); expect(children).toBe(1)
    } finally { await host.shutdown({ mode: 'drain' }).catch(cause => { if (mode !== 'control-failure') throw cause }) }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const parent = projectAgentSession((await repository.open(parseSessionId(spec.members[0]!.sessionId))).snapshot())
      const child = projectAgentSession((await repository.open(parent.subagents.delegations[0]!.payload.childSessionId)).snapshot())
      const workflow = projectWorkflowSession((await repository.open(parseSessionId(spec.workflows.definitions[0]!.sessionId))).snapshot())
      expect(parent.roots[0]!.outcome).toBe(mode === 'drain' ? null : 'cancelled')
      expect(child.roots[0]!.outcome).toBe(mode === 'drain' ? null : 'cancelled')
      expect(workflow.controls.some(item => item.requested.payload.kind === 'cancel')).toBe(mode !== 'drain' && mode !== 'control-failure')
      if (mode === 'work-cancel') expect(workflow.closed).not.toBeNull()
      else expect(workflow.closed).toBeNull()
    } finally { await repository.dispose() }
  } finally { spy.mockRestore(); await rm(directory, { recursive: true, force: true }) }
}, 60000)


it('joins a late cancellation after resource release starts without writing new controls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-release-mode-'))
  try {
    const spec = await delegatedWorkflowHost(directory)
    await initializeHost(spec)
    let releaseStarted!: () => void, allowRelease!: () => void
    const started = new Promise<void>(resolve => { releaseStarted = resolve })
    const release = new Promise<void>(resolve => { allowRelease = resolve })
    const host = await openHost(spec, { bindings: { createModelProvider: member => {
      const provider = new ScriptedModelProvider({ ...member.model, script: async function* () {} })
      return { descriptor: provider.descriptor, prepare: request => provider.prepare(request),
        dispose: async () => { releaseStarted(); await release; await provider.dispose() } }
    } } })
    const closing = host.shutdown({ mode: 'drain' })
    await started
    expect(host.shutdown({ mode: 'cancel' })).toBe(closing)
    allowRelease(); await closing
    expect(host.status).toBe('stopped')
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const workflow = projectWorkflowSession((await repository.open(parseSessionId(spec.workflows.definitions[0]!.sessionId))).snapshot())
      expect(workflow.controls).toEqual([])
    } finally { await repository.dispose() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

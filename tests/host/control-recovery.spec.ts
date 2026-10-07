import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import type { AtomicHost } from '../../src/host/runtime.js'
import { runnableWorkflowHost } from '../workflow/host-fixture.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { nodeHostTimer } from '../../src/host/timer.js'
import { hostConfig } from './fixtures.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { formatSessionAddress, formatSessionEventId, parseSessionId, sessionSequence } from '../../src/session/ids.js'
import { parseMessageId } from '../../src/communication/ids.js'
import { waitingDelegations } from './subagent-control-fixture.js'
import { delegatedWorkflowHost } from '../workflow/subagent-fixture.js'

it('reports uncertified online absence after a real File append acknowledgement is lost and recovers the committed key on reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-lost-ack-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(directory), directory))
  await initializeHost(spec)
  const openWriter = FileSessionBackend.prototype.openWriter
  let lost = false
  const spy = vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id) {
    const writer = await openWriter.call(this, id)
    return { ...writer, append: async (position, event) => {
      const committed = await writer.append(position, event)
      if (!lost && event.type === 'agent/input-accepted' && event.payloadVersion === 2) { lost = true; throw new Error('acknowledgement lost after commit') }
      return committed
    } }
  })
  try {
    const host = await openHost(spec)
    try {
      await expect(host.submitKeyedInput('writer', { kind: 'task', text: 'Durable task', originLabel: 'api:test' }, { namespace: 'api:test', key: 'durable' })).rejects.toMatchObject({ code: 'AGENT_COMMIT_UNKNOWN' })
      const read = host.read(), id = formatSessionEventId(parseSessionId(spec.members[0]!.sessionId), sessionSequence(999))
      expect(read.agent('writer')).toMatchObject({ faulted: true, recoveryRequired: true })
      const current = read.status().report
      expect(current.members[0]).toMatchObject({ faulted: true, readiness: { blockedBy: 'idle' } })
      expect(current.counts.blockedMembers).toBe(1)
      expect(() => read.input('writer', { namespace: 'api:test', key: 'durable' })).toThrowError(expect.objectContaining({ code: 'HOST_RECOVERY_REQUIRED' }))
      expect(() => read.input('writer', { inputEventId: id })).toThrowError(expect.objectContaining({ code: 'HOST_RECOVERY_REQUIRED' }))
      expect(() => read.root('writer', id)).toThrowError(expect.objectContaining({ code: 'HOST_RECOVERY_REQUIRED' }))
      expect(() => read.message('writer', parseMessageId('70000000-0000-4000-8000-000000000999'), 'outbox')).toThrowError(expect.objectContaining({ code: 'HOST_RECOVERY_REQUIRED' }))
    } finally { await host.shutdown({ mode: 'drain' }) }
    spy.mockRestore()
    const reopened = await openHost(spec)
    try {
      expect(reopened.read().input('writer', { namespace: 'api:test', key: 'durable' })).toMatchObject({ status: 'queued', recoveryRequired: false })
      expect(await reopened.submitKeyedInput('writer', { kind: 'task', text: 'Durable task', originLabel: 'api:test' }, { namespace: 'api:test', key: 'durable' })).toMatchObject({ reused: true })
    } finally { await reopened.shutdown() }
  } finally { spy.mockRestore(); await rm(directory, { recursive: true, force: true }) }
})

it('blocks finite Workflow observation after actual owner cleanup failure and retains health after disabling the member', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-recovery-'))
  try {
    const spec = runnableWorkflowHost(directory)
    await initializeHost(spec)
    const timer = { ...nodeHostTimer, wait: vi.fn(nodeHostTimer.wait) }
    const host = await openHost(spec, { timer, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      onClose: () => { throw new Error('model release failed') },
      script: async function* () {
        yield { kind: 'message-start', responseId: 'cleanup-fault', reportedModel: member.spec.target.model }
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: '{"text":"candidate"}' }
        yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: 'stop' }
      } }) } })
    try {
      await host.workflow('research').resume({ requestKey: 'begin' })
      await expect(host.run()).rejects.toMatchObject({ code: 'EFFECT_DISPOSAL_FAILED' })
      expect(host.read().workflow('research')).toMatchObject({ recoveryRequired: true, closed: false })
      const member = host.read().agent('writer')
      expect(member).toMatchObject({ faulted: true, recoveryRequired: true })
      expect(host.read().root('writer', member.report.roots[0]!.id)).toMatchObject({ executionPending: true, final: null })
      timer.wait.mockClear()
      await expect(host.workflow('research').wait({ until: 'closed', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
      expect(timer.wait).not.toHaveBeenCalled()
      await expect(host.setMailboxOnline('writer', false)).rejects.toMatchObject({ code: 'EFFECT_DISPOSAL_FAILED' })
      expect(host.read().agent('writer')).toMatchObject({ recoveryRequired: true, mailbox: 'known-offline' })
      expect(() => host.resume('writer')).not.toThrow()
      expect(host.report().counts.blockedMembers).toBe(1)
      expect(() => host.read().input('writer', { namespace: 'api:absent', key: 'unknown' })).toThrowError(expect.objectContaining({ code: 'HOST_RECOVERY_REQUIRED' }))
      expect(host.read().workflow('research').recoveryRequired).toBe(true)
    } finally { await host.shutdown({ mode: 'drain' }).catch(cause => { expect(cause).toMatchObject({ code: 'HOST_CLEANUP_FAILED' }) }) }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('distinguishes an active Child Run from a committed settlement whose acknowledgement was lost', async () => {
  const timer = { ...nodeHostTimer, wait: vi.fn(nodeHostTimer.wait) }
  const fixture = await waitingDelegations({ count: 1, childResponse: 'Completed Child', timer })
  const parent = fixture.parents[0]!, receipt = fixture.receipts[0]!
  const relation = parent.inspect(receipt.delegationId)
  const target = { kind: 'child' as const, parentAgentKey: 'writer', parentRoot: relation.parentRoot, delegationId: receipt.delegationId }
  let release!: () => void; let reached!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const atSettlement = new Promise<void>(resolve => { reached = resolve })
  let committedEvent: string | undefined
  let running: Promise<unknown> | undefined
  const openWriter = FileSessionBackend.prototype.openWriter
  const spy = vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id) {
    const writer = await openWriter.call(this, id)
    if (id !== receipt.childSessionId) return writer
    return { ...writer, append: async (position, event) => {
      if (event.type !== 'agent/run-settled' || committedEvent !== undefined) return writer.append(position, event)
      reached(); await hold
      await writer.append(position, event)
      committedEvent = (await writer.readCommitted()).events.at(-1)!.eventId
      throw new Error('Child Run settlement acknowledgement lost after commit')
    } }
  })
  try {
    running = fixture.host.run()
    await Promise.race([atSettlement, running.then(() => { throw new Error('Child did not reach its Run settlement') })])
    const active = await fixture.host.read().events(target, { maxEvents: 1000 })
    expect(active.events.at(-1)!.type).toBe('agent/turn-settled')
    expect(active.events.some(event => event.type === 'agent/run-started')).toBe(true)
    expect(active.events.some(event => event.type === 'agent/run-settled')).toBe(false)
    expect(fixture.host.read().delegation('writer', relation.parentRoot, receipt.delegationId)).toMatchObject({ recoveryRequired: false, executionReleased: false })
    expect(await parent.wait(receipt.delegationId, { until: 'closed', timeoutMs: 5 })).toMatchObject({ status: 'timeout', observation: { recoveryRequired: false } })

    release(); await running
    expect(committedEvent).toBeDefined()
    const certified = await fixture.host.read().events(target, { maxEvents: 1000 })
    expect(certified.through).toBe(active.through)
    expect(certified.events.some(event => event.eventId === committedEvent)).toBe(false)
    expect(parent.inspect(receipt.delegationId)).toMatchObject({ businessResolved: true, executionReleased: false, recoveryRequired: true, failed: false })
    expect(fixture.host.delegationReport().blocked).toBe(1)
    expect(fixture.host.read().delegation('writer', relation.parentRoot, receipt.delegationId)).toMatchObject({ recoveryRequired: true, closed: false })
    timer.wait.mockClear()
    await expect(parent.wait(receipt.delegationId, { until: 'closed', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
    expect(timer.wait).not.toHaveBeenCalled()
  } finally {
    release(); await running
    spy.mockRestore()
    await fixture.host.shutdown({ mode: 'drain' }).catch(cause => { expect(cause).toMatchObject({ code: 'HOST_CLEANUP_FAILED' }) })
    await rm(fixture.root, { recursive: true, force: true })
  }
}, 30000)

it('attributes a faulted private Child to its owning Root and Workflow without blocking independent observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-workflow-child-'))
  const clock = { now: () => Date.parse('2026-10-07T15:00:00Z') }
  const timer = { ...nodeHostTimer, wait: vi.fn(nodeHostTimer.wait) }
  let release!: () => void; let reached!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const atSettlement = new Promise<void>(resolve => { reached = resolve })
  let committed = false, parentCalls = 0
  let running: Promise<unknown> | undefined
  let host: AtomicHost | undefined
  let spy: { mockRestore(): void } | undefined
  try {
    const base = await delegatedWorkflowHost(directory)
    if (base.workflows.kind !== 'enabled') throw new Error('Workflow fixture disabled')
    const definition = base.workflows.definitions[0]!
    const independentSession = parseSessionId('87000000-0000-4000-8000-000000000002')
    const spec = { ...base, workflows: { ...base.workflows, definitions: [...base.workflows.definitions,
      { ...definition, sessionId: independentSession, definition: { ...definition.definition, workflowKey: 'independent', coordinator: formatSessionAddress(independentSession) } }] } }
    const known = new Set([...spec.members.map(member => member.sessionId), ...spec.workflows.definitions.map(entry => entry.sessionId)])
    await initializeHost(spec, { clock })
    const openWriter = FileSessionBackend.prototype.openWriter
    spy = vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id) {
      const writer = await openWriter.call(this, id)
      if (known.has(id)) return writer
      return { ...writer, append: async (position, event) => {
        if (event.type !== 'agent/run-settled' || committed) return writer.append(position, event)
        reached(); await hold
        await writer.append(position, event)
        committed = (await writer.readCommitted()).events.at(-1)!.eventId === event.eventId
        throw new Error('Child Run settlement acknowledgement lost after commit')
      } }
    })
    host = await openHost(spec, { clock, timer, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* () {
        const parent = member.agentKey === 'writer', child = member.agentKey.startsWith('child.')
        if (parent) parentCalls++
        yield { kind: 'message-start', responseId: 'child-owner-health', reportedModel: member.spec.target.model }
        if (parent && parentCalls === 2) {
          yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'spawn', name: 'agent_spawn_subagent' }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ templateKey: 'research', templateVersion: 1, task: 'Check source', materials: [],
            requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }) }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          yield { kind: 'block-start', index: 0, block: 'text' }
          yield { kind: 'text-delta', index: 0, text: child ? 'Child evidence' : '{"text":"independent result"}' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } }) } })
    await host.submitTask('writer', 'Independent ordinary task')
    await host.run()
    const independentRoot = host.read().agent('writer').report.roots[0]!.id
    expect(host.read().root('writer', independentRoot)).toMatchObject({ outcome: 'completed', recoveryRequired: false })
    await host.workflow('research').resume({ requestKey: 'begin' })
    running = host.run()
    await Promise.race([atSettlement, running.then(() => { throw new Error('Workflow Child did not reach its Run settlement') })])
    const delegation = host.delegationReport().delegations[0]!
    expect(host.read().root('writer', delegation.parentRoot)).toMatchObject({ outcome: null, recoveryRequired: false })
    expect(host.read().workflow('research').recoveryRequired).toBe(false)
    release(); await running
    expect(committed).toBe(true)
    expect(host.read().root('writer', delegation.parentRoot)).toMatchObject({ outcome: null, executionPending: true, recoveryRequired: true })
    expect(host.read().workflow('research')).toMatchObject({ closed: false, recoveryRequired: true })
    expect(host.read().root('writer', independentRoot).recoveryRequired).toBe(false)
    expect(host.read().workflow('independent').recoveryRequired).toBe(false)
    expect(host.read().agent('writer').recoveryRequired).toBe(false)
    timer.wait.mockClear()
    const reads = host.read()
    await expect(host.observe(() => reads.root('writer', delegation.parentRoot), result => result.outcome !== null,
      { timeoutMs: 1000, scanIntervalMs: 5 })).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
    await expect(host.workflow('research').wait({ until: 'closed', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
    expect(timer.wait).not.toHaveBeenCalled()
  } finally {
    release(); await running
    spy?.mockRestore()
    await host?.shutdown({ mode: 'drain' }).catch(cause => { expect(cause).toMatchObject({ code: 'HOST_CLEANUP_FAILED' }) })
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost, recoverHost, FileSessionBackend, SessionRepository, hostRuntimeEventCatalog, parseSessionId } from '../../src/index.js'
import type { SessionSnapshot, SessionEventId, JsonObject, AtomicHost } from '../../src/index.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { encodeFrame } from '../../src/session/frame.js'
import { encodeSessionHeader, encodeStoredSessionEvent } from '../../src/session/codec.js'
import { subagentHostConfig } from './subagent-fixture.js'
import { hostSessionId } from './fixtures.js'
import { AgentJournal } from '../../src/agent/journal.js'
import { SubagentAdmission } from '../../src/subagent/admission.js'
import type { AcceptedDelegation } from '../../src/subagent/admission.js'
import { resultProtocolAction } from '../../src/subagent/protocol-maintenance.js'
import { effectiveResourceRelease } from '../../src/subagent/resource-evidence.js'

const clock = { now: () => Date.parse('2026-09-22T00:00:00Z') }
let parent: SessionSnapshot; let child: SessionSnapshot; let original: JsonObject; let traceRoot: string
beforeAll(async () => {
  traceRoot = await mkdtemp(join(tmpdir(), 'atomic-trace-'))
  original = await subagentHostConfig(traceRoot)
  const spec = resolveHostConfig(decodeHostConfig(original, traceRoot))
  await initializeHost(spec, { clock })
  let calls = 0
  const host = await openHost(spec, { clock, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    script: async function* (): AsyncGenerator<ModelFrame> {
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'trace' }
      if (member.agentKey === 'writer' && calls++ === 0) {
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'spawn', name: 'agent_spawn_subagent' }
        yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ templateKey: 'research', templateVersion: 1, task: 'Check', materials: [],
          requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }) }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } else {
        yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'verified' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      }
    },
  }) } })
  try { await host.submitTask('writer', 'Delegate'); await host.run(); expect(host.delegationReport().unresolved).toBe(0) }
  finally { await host.shutdown() }
  const repository = new SessionRepository({ backend: new FileSessionBackend({ root: traceRoot, maxRecordBytes: spec.storage.maxRecordBytes }), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
  try {
    parent = await repository.read(parseSessionId(hostSessionId))
    child = await repository.read(projectAgentSession(parent).subagents.delegations[0]!.payload.childSessionId)
  } finally { await repository.dispose() }
}, 20000)
afterAll(async () => { await rm(traceRoot, { recursive: true, force: true }) })

async function prefix(root: string, snapshot: SessionSnapshot, count: number) {
  const path = join(root, 'sessions', snapshot.header.sessionId)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'header.frame'), encodeFrame(encodeSessionHeader(snapshot.header), 65536))
  await writeFile(join(path, 'events.log'), Buffer.concat(snapshot.history.at(-1)!.events.slice(0, count).map(item => encodeFrame(encodeStoredSessionEvent(item.stored), 1048576))))
}

it.each(['cp-d', 'header', 'subagent/child-bound', 'context/profile-recorded', 'agent/spec-recorded', 'ready', 'task-ack', 'model/invocation-prepared', 'model/invocation-started', 'subagent/protocol-recorded', 'result-ack', 'result-classified'] as const)(
  'recovers the causal %s cut without replaying an old external call', async cut => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-cut-'))
    let host: AtomicHost | undefined
    try {
      const state = projectAgentSession(parent); const cp = state.subagents.delegations[0]!
      const installation = ['header', 'subagent/child-bound', 'context/profile-recorded', 'agent/spec-recorded', 'ready'].includes(cut)
      const resultCut = cut === 'result-ack' || cut === 'result-classified'
      const childCount = cut === 'cp-d' || cut === 'header' ? 0 : cut === 'ready' ? projectAgentSession(child).subagents.ready!.stored.sequence
        : cut === 'task-ack' ? child.history.at(-1)!.events.find(item => item.stored.type === 'communication/inbox-accepted')!.stored.sequence
        : resultCut ? child.history.at(-1)!.events.find(item => item.stored.type === (cut === 'result-classified' ? 'communication/outbox-delivered' : 'communication/outbox-attempt-started'))!.stored.sequence
        : child.history.at(-1)!.events.find(item => item.stored.type === cut)!.stored.sequence
      const parentCount = cut === 'cp-d' ? cp.stored.sequence : installation
        ? state.turns[0]!.settled!.stored.sequence
        : cut === 'task-ack' ? parent.history.at(-1)!.events.find(item => item.stored.type === 'communication/outbox-attempt-started')!.stored.sequence
        : resultCut ? parent.history.at(-1)!.events.find(item => item.stored.type === (cut === 'result-ack' ? 'communication/inbox-accepted' : 'subagent/message-classified'))!.stored.sequence
        : parent.history.at(-1)!.events.find(item => item.stored.type === 'communication/outbox-delivered')!.stored.sequence
      await prefix(root, parent, parentCount)
      if (cut !== 'cp-d') await prefix(root, child, childCount)
      const config = { ...original, storage: { ...(original.storage as JsonObject), root } }
      const spec = resolveHostConfig(decodeHostConfig(config, root))
      let acquired = 0; let childCalls = 0
      const bindings = { createModelProvider: (member: Parameters<NonNullable<import('../../src/host/slot.js').HostRuntimeBindings['createModelProvider']>>[0]) => {
        acquired++
        return new ScriptedModelProvider({ ...member.model, script: async function* (): AsyncGenerator<ModelFrame> {
          if (member.agentKey !== 'writer') childCalls++
          yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'resumed' }
          yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'resumed result' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        } })
      } }
      const first = await recoverHost(spec, { predecessorStopped: true, maxRecoveryWrites: 2, maxJournalConflicts: 4, clock })
      expect(first.every(item => 'totalWrites' in item.result && item.result.totalWrites <= 2)).toBe(true)
      expect(acquired).toBe(0)
      const domains: Record<string, SessionEventId | null> = {}
      for (const item of first) if ('openAgentRecovery' in item.result) {
        domains[item.sessionId + ':agent'] = item.result.openAgentRecovery
        for (const id of item.result.openDelegationRecoveries) domains[item.sessionId + ':subagent:' + cp.stored.eventId] = id
      }
      if (Object.values(domains).some(value => value !== null)) await expect(recoverHost(spec, { predecessorStopped: true, maxRecoveryWrites: 20, maxJournalConflicts: 4, clock }))
        .rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
      const recovered = await recoverHost(spec, { predecessorStopped: true, maxRecoveryWrites: 20, maxJournalConflicts: 4, clock, domainSupersedes: domains })
      expect(recovered.every(item => 'totalWrites' in item.result && item.result.totalWrites <= 20)).toBe(true)
      expect(acquired).toBe(0)
      host = await openHost(spec, { clock, bindings })
      expect(host.resume('writer')).toMatchObject([{ status: 'resumed' }])
      await host.run()
      expect(host.delegationReport().delegations[0], JSON.stringify(host.delegationReport())).toMatchObject({ childSessionId: child.header.sessionId, closed: true })
      expect(childCalls).toBe(cut === 'cp-d' || cut === 'task-ack' || installation ? 1 : 0)
    } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
  }, 30000)

it('waits for the resumed Child execution to release before publishing its result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-result-release-'))
  let host: AtomicHost | undefined; let running: Promise<unknown> | undefined
  let release!: () => void; let reached!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const atTerminalRun = new Promise<void>(resolve => { reached = resolve })
  const spies: { mockRestore(): void }[] = []
  try {
    await prefix(root, parent, parent.history.at(-1)!.events.find(item => item.stored.type === 'communication/outbox-attempt-started')!.stored.sequence)
    await prefix(root, child, child.history.at(-1)!.events.find(item => item.stored.type === 'communication/inbox-accepted')!.stored.sequence)
    const spec = resolveHostConfig(decodeHostConfig({ ...original, storage: { ...(original.storage as JsonObject), root } }, root))
    await recoverHost(spec, { predecessorStopped: true, maxRecoveryWrites: 20, maxJournalConflicts: 4, clock })
    let accepted: AcceptedDelegation | undefined; let childJournal: AgentJournal | undefined
    const restore = SubagentAdmission.prototype.restore
    spies.push(vi.spyOn(SubagentAdmission.prototype, 'restore').mockImplementation(async function (this: SubagentAdmission, ...args) {
      accepted = await restore.apply(this, args)
      return accepted
    }))
    const append = AgentJournal.prototype.append
    spies.push(vi.spyOn(AgentJournal.prototype, 'append').mockImplementation(function (this: AgentJournal, ...args) {
      // eslint-disable-next-line typescript/no-this-alias -- The spy captures the actual Child journal for the recovery cut.
      if (this.session.header.sessionId === child.header.sessionId) childJournal = this
      return append.apply(this, args)
    }))
    const openWriter = FileSessionBackend.prototype.openWriter
    spies.push(vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id) {
      const writer = await openWriter.call(this, id)
      if (id !== child.header.sessionId) return writer
      return { ...writer, append: async (position, event) => {
        if (event.type === 'agent/run-settled') { reached(); await hold }
        return writer.append(position, event)
      } }
    }))
    host = await openHost(spec, { clock, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* () {
        yield { kind: 'message-start', responseId: 'release-order', reportedModel: member.spec.target.model }
        yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: 'resumed result' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      },
    }) } })
    expect(host.resume('writer')).toMatchObject([{ status: 'resumed' }])
    running = host.run()
    await Promise.race([atTerminalRun, running.then(() => { throw new Error('Host stopped before the Child terminal Run cut') })])
    const state = projectAgentSession(childJournal!.session.snapshot())
    const execution = state.subagents.resources.filter(item => item.opened.payload.component === 'execution')
    expect(state.roots[0]!.outcome).toBe('completed')
    expect(state.openTurn).toBeNull()
    expect(state.openRun).not.toBeNull()
    expect(execution.map(item => item.opened.payload.generation)).toEqual([1, 2])
    expect(effectiveResourceRelease(execution[0]!, state.subagents.recoveries)?.outcome).toBe('released')
    expect(effectiveResourceRelease(execution[1]!, state.subagents.recoveries)).toBeNull()
    expect(resultProtocolAction(accepted!, childJournal!.session, childJournal!, clock)).toBeUndefined()
    release()
    await running
    expect(host.delegationReport().delegations[0], JSON.stringify(host.delegationReport())).toMatchObject({ closed: true, recoveryRequired: false })
  } finally {
    release(); await running; await host?.shutdown()
    for (const spy of spies.reverse()) spy.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it('rejects a receiver prefix whose sending Outbox was removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-invalid-cut-'))
  try {
    await prefix(root, parent, projectAgentSession(parent).subagents.delegations[0]!.stored.sequence)
    await prefix(root, child, child.localPosition)
    const spec = resolveHostConfig(decodeHostConfig({ ...original, storage: { ...(original.storage as JsonObject), root } }, root))
    await expect(recoverHost(spec, { predecessorStopped: true, maxRecoveryWrites: 20, maxJournalConflicts: 4, clock })).rejects.toMatchObject({ code: 'SUBAGENT_STATE_INVALID' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { expect, it, vi } from 'vitest'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost, ScriptedModelProvider,
  FileSessionBackend, SessionRepository, hostRuntimeEventCatalog, parseSessionId, projectAgentSession,
  projectContextSession, projectCommunicationFacts, rebuildAssembly } from '../../src/index.js'
import type { AtomicHost, DelegationRequest, ModelFrame } from '../../src/index.js'
import { SessionMailboxImpl } from '../../src/communication/mailbox.js'
import { nodeHostTimer } from '../../src/host/timer.js'
import { subagentHostConfig } from '../host/subagent-fixture.js'
import { hostSessionId } from '../host/fixtures.js'

it.each(['rejected', 'exhausted'] as const)('adopts management failure when a Child result is %s without receiving its business content', async kind => {
  const workspace = resolve('.tmp/step11-c0161-context-runtime')
  await mkdir(workspace, { recursive: true })
  const root = await mkdtemp(join(workspace, kind + '-'))
  if (!root.startsWith(workspace + sep)) throw new Error('invalid cleanup target')
  const secret = 'undelivered-child-business'
  let now = Date.parse('2026-09-22T00:00:00Z')
  const clock = { now: () => now }
  let host: AtomicHost | undefined
  let reader: SessionRepository | undefined
  let parentCalls = 0
  let childCalls = 0
  let resultAttempts = 0
  const receive = SessionMailboxImpl.prototype.acceptDelivery
  const rejection = vi.spyOn(SessionMailboxImpl.prototype, 'acceptDelivery').mockImplementation(function (this: SessionMailboxImpl, envelope, ...rest) {
    if (envelope.type === 'subagent/result') {
      resultAttempts++
      return Promise.resolve(kind === 'rejected' ? { kind: 'rejected', code: 'receive-forbidden' } : { kind: 'retry', code: 'recipient-backpressure' })
    }
    return receive.call(this, envelope, ...rest)
  })
  try {
    const spec = resolveHostConfig(decodeHostConfig(await subagentHostConfig(root), root))
    const request: DelegationRequest = { templateKey: 'research', templateVersion: 1, task: 'Check', materials: [],
      requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }
    await initializeHost(spec, { clock })
    host = await openHost(spec, { clock, timer: { now: () => now, wait: nodeHostTimer.wait },
      bindings: { createModelProvider: item => new ScriptedModelProvider({ ...item.model,
        script: async function* (submission): AsyncGenerator<ModelFrame> {
          const parent = item.agentKey === 'writer'
          const call = parent ? parentCalls++ : childCalls++
          yield { kind: 'message-start', reportedModel: item.spec.target.model, responseId: 'failed-result' }
          if (parent && call === 0) {
            yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'spawn', name: 'agent_spawn_subagent' }
            yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(request) }
            yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
          } else {
            if (parent) {
              expect(JSON.stringify(submission.request)).toContain('subagent-failure')
              expect(JSON.stringify(submission.request)).not.toContain(secret)
            }
            yield { kind: 'block-start', index: 0, block: 'text' }
            yield { kind: 'text-delta', index: 0, text: parent ? 'handled-failure' : secret }
            yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
          }
        },
      }) } })
    await host.submitTask('writer', 'Delegate and handle failure')
    let run = await host.run()
    while (host.report().members[0]!.agent.roots[0]!.outcome === null || !host.delegationReport().delegations[0]?.closed) {
      if (['quiescent', 'no-progress'].includes(run.stoppedBy)) {
        if (kind === 'exhausted' && resultAttempts < spec.communication.maxDeliveryAttempts) now += spec.scheduling.retryIntervalMs + 1
        else throw new Error('Host stopped before the Root and delegation settled')
      }
      run = await host.run()
    }
    const report = host.report().members[0]!.agent
    expect(report, report.roots[0]!.reason ?? 'unknown-root-reason').toMatchObject({ roots: [{ outcome: 'completed' }],
      counts: { pendingWaits: 0 }, final: { text: 'handled-failure' } })
    expect(host.delegationReport().delegations[0]).toMatchObject({ adopted: true, businessResolved: true, executionReleased: true, closed: true })
    expect(parentCalls).toBe(2)
    expect(childCalls).toBe(1)
    expect(resultAttempts).toBe(kind === 'rejected' ? 1 : spec.communication.maxDeliveryAttempts)
    await host.shutdown(); host = undefined
    reader = new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: spec.storage.maxRecordBytes }),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: spec.storage.maxLineageDepth })
    const parent = await reader.read(parseSessionId(hostSessionId))
    const state = projectAgentSession(parent)
    const delegation = state.subagents.delegations[0]!
    const input = state.inputs.find(input => input.protocol?.kind === 'failure' && input.claimedBy !== null)!
    expect(state.roots).toHaveLength(1)
    expect(state.turns.find(turn => turn.started.stored.eventId === input.claimedBy)!.root).toBe(state.roots[0]!.id)
    const observed = state.subagents.observations.find(item => item.stored.eventId === input.reference.eventId)!
    expect(observed.payload.deliveryFailures).toHaveLength(1)
    expect(input.protocol!.inbox).toBe(observed.stored.eventId)
    expect(JSON.stringify(parent)).not.toContain(secret)
    expect(projectCommunicationFacts(parent).inbox.filter(item => item.envelope.type === 'subagent/result')).toHaveLength(0)
    const assemblies = projectContextSession(parent).assemblies
    const adopted = assemblies.find(item => item.committed.payload.selected.some(unit => unit.reference.eventId === input.reference.eventId))!
    const selected = adopted.committed.payload.selected
    const failure = selected.find(unit => unit.reference.eventId === input.reference.eventId)!
    const obligation = selected.find(unit => unit.reference.eventId === delegation.stored.eventId)!
    expect(failure.sourceEventIds).toEqual([input.reference.eventId, input.claimedBy])
    expect(obligation.sourceEventIds).toEqual([delegation.stored.eventId, input.reference.eventId])
    for (const unit of [failure, obligation]) expect(adopted.committed.payload.provenance.find(entry => entry.source.kind === 'unit'
      && entry.source.reference.eventId === unit.reference.eventId)!.source).toMatchObject({ kind: 'unit', eventIds: unit.sourceEventIds })
    const child = await reader.read(parseSessionId(delegation.payload.childSessionId))
    expect(projectAgentSession(child).subagents.failures).toHaveLength(1)
    for (const snapshot of [parent, child]) for (const assembly of projectContextSession(snapshot).assemblies) {
      for (const unit of assembly.committed.payload.selected) expect(new Set(unit.sourceEventIds).size).toBe(unit.sourceEventIds.length)
      expect(rebuildAssembly(snapshot, assembly.committed.stored.eventId)).toMatchObject({ kind: 'rebuilt', request: assembly.committed.payload.request })
    }
    expect(parentCalls).toBe(2)
    expect(childCalls).toBe(1)
  } finally {
    rejection.mockRestore()
    await host?.shutdown()
    await reader?.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

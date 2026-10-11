import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost, formatSessionAddress, parseSessionId,
  FileSessionBackend, SessionRepository, hostRuntimeEventCatalog, projectAgentSession, projectContextSession, rebuildAssembly } from '../../src/index.js'
import type { AtomicHost, JsonObject, DelegationRequest } from '../../src/index.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { SubagentAdmission } from '../../src/subagent/admission.js'
import { delegationRequestedEvent } from '../../src/subagent/session-events.js'
import { createCommunicationService } from '../communication/fixtures.js'
import { clock as fixtureClock } from '../agent/fixtures.js'
import { subagentHostConfig } from '../host/subagent-fixture.js'
import { hostSessionId } from '../host/fixtures.js'
import { delegationFixture } from './fixtures.js'

it.each(['maxRequestBytes', 'maxMaterialBytes'] as const)('retains an exact File Host receipt after reducing %s while new requests use the current ceiling', async field => {
  const workspace = resolve('.tmp/step11-c0159-runtime')
  await mkdir(workspace, { recursive: true })
  const root = await mkdtemp(join(workspace, 'receipt-'))
  if (!root.startsWith(workspace + sep)) throw new Error('invalid cleanup target')
  const clock = { now: () => Date.parse('2026-09-22T00:00:00Z') }
  let host: AtomicHost | undefined
  let parentAcquisitions = 0
  let childAcquisitions = 0
  try {
    const base = await subagentHostConfig(root)
    const member = (base.members as JsonObject[])[0]!
    const raw: JsonObject = { ...base, members: [{ ...member, spec: { ...(member.spec as JsonObject),
      nativeActions: [...((member.spec as JsonObject).nativeActions as string[]), 'agent_ask_user'] } }] }
    const spec = resolveHostConfig(decodeHostConfig(raw, root))
    const bindings = { createModelProvider: (item: Parameters<NonNullable<import('../../src/host/slot.js').HostRuntimeBindings['createModelProvider']>>[0]) => {
      if (item.agentKey === 'writer') parentAcquisitions++
      else childAcquisitions++
      return new ScriptedModelProvider({ ...item.model,
        script: async function* (): AsyncGenerator<ModelFrame> {
          yield { kind: 'message-start', reportedModel: item.spec.target.model, responseId: 'receipt' }
          yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'wait', name: 'agent_ask_user' }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ question: 'Start?', timeoutMs: 30000 }) }
          yield { kind: 'block-end', index: 0 }
          yield { kind: 'complete', stopReason: 'tool-calls' }
        },
      })
    } }
    await initializeHost(spec, { clock })
    host = await openHost(spec, { clock, bindings })
    await host.submitTask('writer', 'Wait for authorization')
    const waiting = (await host.run()).members[0]!.agent
    const rootId = waiting.roots[0]!.id
    const address = formatSessionAddress(parseSessionId(hostSessionId))
    const parent = host.bindParent(address, rootId)
    const request: DelegationRequest = { templateKey: 'research', templateVersion: 1, task: 'x'.repeat(1024),
      materials: [{ label: 'evidence', text: 'm'.repeat(256) }],
      requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }
    const receipt = await parent.spawn('ack-loss', request)
    const budget = host.report().members[0]!.agent.roots[0]!.budget
    await host.shutdown(); host = undefined

    const domain = raw.subagents as JsonObject
    const changed = resolveHostConfig(decodeHostConfig({ ...raw, subagents: { ...domain,
      limits: { ...(domain.limits as JsonObject), [field]: field === 'maxRequestBytes' ? 512 : 16 } } }, root))
    host = await openHost(changed, { clock, bindings })
    const rebound = host.bindParent(address, rootId)
    const mutable = { ...request, materials: request.materials.map(item => ({ ...item })) }
    const retry = rebound.spawn('ack-loss', mutable)
    mutable.task = 'changed-after-enqueue'
    mutable.materials[0]!.text = 'changed-after-enqueue'
    expect(await retry).toEqual(receipt)
    await expect(Promise.resolve().then(() => rebound.spawn('ack-loss', { ...request, task: 'changed' })))
      .rejects.toMatchObject({ code: 'SUBAGENT_REQUEST_CONFLICT' })
    await expect(Promise.resolve().then(() => rebound.spawn('new-key', request)))
      .rejects.toMatchObject({ code: 'SUBAGENT_REQUEST_INVALID' })
    await expect(Promise.resolve().then(() => rebound.spawn('ack-loss', { ...request, task: 'x'.repeat(16385) })))
      .rejects.toMatchObject({ code: 'SUBAGENT_REQUEST_INVALID' })
    expect(host.delegationReport().count).toBe(1)
    expect(host.report().members[0]!.agent.roots[0]!.budget).toEqual(budget)
    expect(parentAcquisitions).toBe(2)
    expect(childAcquisitions).toBe(0)
  } finally {
    await host?.shutdown()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it('scopes direct admission receipt lookup to the authorized parent and exact root, and snapshots before its gate', async () => {
  const f = await delegationFixture()
  const c = createCommunicationService()
  try {
    const cp = await f.journal.append(delegationRequestedEvent, () => f.requested)
    const role = f.spec.subagents
    if (role.role !== 'parent') throw new Error('parent fixture required')
    const { role: _role, ...authority } = role
    const admission = new SubagentAdmission({ kind: 'enabled', templates: [f.template],
      parents: [{ ...authority, agentKey: 'parent' }], workspaceResources: [],
      limits: { ...f.template.limits, maxRequestBytes: 1 } }, c.service, fixtureClock)
    const captured = { ...f.requested.request }
    const retry = admission.spawn('parent', f.session, f.requested.parentRoot, f.requested.source, captured)
    captured.task = 'changed-after-enqueue'
    expect(await retry).toEqual({ delegationId: cp.stored.eventId, childAddress: cp.payload.childAddress, childSessionId: cp.payload.childSessionId })
    expect(() => admission.spawn('other-parent', f.session, f.requested.parentRoot, f.requested.source, f.requested.request))
      .toThrow('parent-not-authorized')
    expect(() => admission.spawn('parent', f.session, f.spec.profileEventId, f.requested.source, f.requested.request))
      .toThrow('parent-root-stopped')
    expect(() => admission.spawn('parent', f.session, f.requested.parentRoot, { kind: 'programmatic', requestKey: 'new-key' }, f.requested.request))
      .toThrow('invalid-request')
    expect(f.agent.snapshot().subagents.delegations).toHaveLength(1)
  } finally {
    await c.service.dispose(); await c.transport.dispose(); await c.directory.dispose(); await f.close()
  }
})

it.each(['result', 'failure'] as const)('rejects another native await after this root adopts the Child %s, then completes through recorded feedback', async adoptedKind => {
  const workspace = resolve('.tmp/step11-c0159-runtime')
  await mkdir(workspace, { recursive: true })
  const root = await mkdtemp(join(workspace, 'adopted-'))
  if (!root.startsWith(workspace + sep)) throw new Error('invalid cleanup target')
  const clock = { now: () => Date.parse('2026-09-22T00:00:00Z') }
  let host: AtomicHost | undefined
  let repository: SessionRepository | undefined
  let parentCalls = 0
  let childCalls = 0
  try {
    const spec = resolveHostConfig(decodeHostConfig(await subagentHostConfig(root), root))
    const request: DelegationRequest = { templateKey: 'research', templateVersion: 1, task: 'Check', materials: [],
      requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }
    await initializeHost(spec, { clock })
    host = await openHost(spec, { clock, bindings: { createModelProvider: item => {
      if (item.agentKey !== 'writer' && adoptedKind === 'failure') throw new Error('child-provider-unavailable')
      return new ScriptedModelProvider({ ...item.model,
        script: async function* (submission): AsyncGenerator<ModelFrame> {
          const isParent = item.agentKey === 'writer'
          const call = isParent ? parentCalls++ : childCalls++
          yield { kind: 'message-start', reportedModel: item.spec.target.model, responseId: 'adopted' }
          if (isParent && call < 2) {
            if (call === 1 && adoptedKind === 'failure') {
              expect(JSON.stringify(submission.request)).toContain('subagent-failure')
              expect(JSON.stringify(submission.request)).toContain('child-acquisition-failed')
            }
            const delegationId = call === 1 ? host!.delegationReport().delegations[0]!.delegationId : undefined
            yield { kind: 'block-start', index: 0, block: 'tool-call', callId: `parent-${call}`, name: call === 0 ? 'agent_spawn_subagent' : 'agent_await_subagent' }
            yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(call === 0 ? request : { delegationId, timeoutMs: 30000 }) }
            yield { kind: 'block-end', index: 0 }
            yield { kind: 'complete', stopReason: 'tool-calls' }
          } else {
            if (isParent) expect(JSON.stringify(submission.request)).toContain('delegation-result-adopted')
            yield { kind: 'block-start', index: 0, block: 'text' }
            yield { kind: 'text-delta', index: 0, text: isParent ? 'integrated' : 'child-result' }
            yield { kind: 'block-end', index: 0 }
            yield { kind: 'complete', stopReason: 'stop' }
          }
        },
      })
    } } })
    await host.submitTask('writer', 'Delegate then finish')
    await host.run()
    expect(host.delegationReport().delegations[0]).toMatchObject({ adopted: true, businessResolved: true, executionReleased: true, closed: true })
    const report = host.report().members[0]!.agent
    expect(report, report.roots[0]!.reason ?? 'unknown-root-reason').toMatchObject({ roots: [{ outcome: 'completed' }], counts: { pendingWaits: 0 }, final: { text: 'integrated' } })
    expect(parentCalls).toBe(3)
    expect(childCalls).toBe(adoptedKind === 'result' ? 1 : 0)
    await host.shutdown(); host = undefined
    repository = new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: spec.storage.maxRecordBytes }),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    const snapshot = await repository.read(parseSessionId(hostSessionId))
    const state = projectAgentSession(snapshot)
    const adopted = state.inputs.find(input => input.protocol?.kind === adoptedKind && input.claimedBy !== null)!
    expect(adopted).toBeDefined()
    expect(state.turns.find(turn => turn.started.stored.eventId === adopted.claimedBy)!.root).toBe(state.roots[0]!.id)
    expect(state.waits).toHaveLength(1)
    expect(state.actions.map(action => action.payload.result)).toContainEqual({ kind: 'not-started', reason: 'delegation-result-adopted' })
    expect(state.roots[0]!.outcome).toBe('completed')
    const assemblies = projectContextSession(snapshot).assemblies
    for (const assembly of assemblies) expect(rebuildAssembly(snapshot, assembly.committed.stored.eventId))
      .toMatchObject({ kind: 'rebuilt', request: assembly.committed.payload.request })
    if (adoptedKind === 'failure') {
      const provision = state.subagents.provisions.find(item => item.stored.eventId === adopted.reference.eventId)!
      expect(provision.payload).toMatchObject({ outcome: 'failed', phase: 'execution', cleanup: 'released', reasonCode: 'child-acquisition-failed' })
      expect(adopted.protocol!.inbox).toBe(adopted.reference.eventId)
      const assembly = assemblies.find(item => item.committed.payload.selected.some(unit => unit.reference.eventId === adopted.reference.eventId))!
      const selected = assembly.committed.payload.selected.find(item => item.reference.eventId === adopted.reference.eventId)!
      expect(selected.sourceEventIds).toEqual([provision.stored.eventId, adopted.claimedBy])
      const provenance = assembly.committed.payload.provenance.find(item => item.source.kind === 'unit'
        && item.source.reference.eventId === adopted.reference.eventId)!
      expect(provenance.source).toMatchObject({ kind: 'unit', eventIds: selected.sourceEventIds })
    }
  } finally {
    await host?.shutdown()
    await repository?.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

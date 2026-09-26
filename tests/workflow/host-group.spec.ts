import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { groupWorkflowHost } from './group-fixture.js'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { SessionRepository } from '../../src/session/repository.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { parseSessionId } from '../../src/session/ids.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { projectCommunicationFacts } from '../../src/communication/projection.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { checkGroupAdmission } from '../../src/workflow/group-admission.js'
import { workGroupRequestedEvent, workGroupResultEvent } from '../../src/workflow/group-events.js'
import { recoverWorkPrefix } from './prefix-fixture.js'
import { groupDeliveryBranch } from './group-delivery-fixture.js'

it.each(['collect-outcomes', 'all-delivered', 'unclaimed'] as const)('delivers a frozen %s group and preserves distinct recipient outcomes', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-group-'))
  try {
    const spec = groupWorkflowHost(root), clock = { now: () => tick }
    const completion = scenario === 'unclaimed' ? 'collect-outcomes' : scenario
    const tick = Date.now(), calls = new Map<string, number>()
    await initializeHost(spec)
    const host = await openHost(spec, { clock, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission): AsyncGenerator<ModelFrame> {
        const count = (calls.get(member.agentKey) ?? 0) + 1; calls.set(member.agentKey, count)
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: member.agentKey + count }
        if (count === 1 && (member.agentKey === 'writer' || scenario !== 'unclaimed')) {
          const sender = member.agentKey === 'writer', name = sender ? 'agent_send_work_group' : 'agent_await_work_message'
          const args = sender ? { targetNodeKeys: ['note3', 'write', 'read', 'note2', 'write'], text: 'Use the shared research criteria.', completion, timeoutMs: 60000 }
            : { kind: 'group', timeoutMs: 60000 }
          yield { kind: 'block-start', index: 0, block: 'tool-call', name, callId: name }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(args) }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          const request = JSON.stringify(submission.request)
          if (scenario === 'unclaimed' && member.agentKey !== 'writer') expect(request).not.toContain('Use the shared research criteria.')
          else expect(request).toContain(member.agentKey === 'writer' ? 'workflow-group-result' : 'Use the shared research criteria.')
          yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: member.agentKey + ' result' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } }) } })
    try {
      for (const member of spec.members) host.pause(member.agentKey)
      await host.workflow('research').resume({ requestKey: 'group' }); await host.run()
      expect(host.workflow('research').report().counts.assignments).toBe(4)
      if (scenario !== 'unclaimed') { for (const member of spec.members.slice(1)) host.resume(member.agentKey); await host.run() }
      host.resume('writer')
      let run = await host.run()
      if (scenario === 'unclaimed') {
        expect(host.workflow('research').report().counts).toMatchObject({ groups: 1, pendingGroups: 0, accepted: 1 })
        expect(calls.size).toBe(1)
        for (const member of spec.members.slice(1)) host.resume(member.agentKey)
        run = await host.run()
      }
      expect(host.workflow('research').report(), JSON.stringify(run)).toMatchObject({ state: 'completed', closed: true,
        counts: { assignments: 4, accepted: 4, groups: 1, pendingGroups: 0, questions: 0 } })
      expect(spec.members.map(member => calls.get(member.agentKey))).toEqual(scenario === 'unclaimed' ? [2, 1, 1, 1] : [2, 2, 2, 2])
    } finally { await host.shutdown() }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const coordinator = await repository.open(parseSessionId(spec.workflows.definitions[0]!.sessionId)), state = projectWorkflowSession(coordinator.snapshot())
      const group = state.interactions[0]!.admitted.payload
      if (group.kind !== 'group') throw new Error('group fixture')
      expect(group.targets.map(item => item.nodeKey)).toEqual(['write', 'note2', 'note3'])
      expect(checkGroupAdmission({ ...state, decisions: [] }, group)?.reason).toBe('work-group-quota')
      const availableSender = { ...state, decisions: [], definition: { ...state.definition!, payload: { ...state.definition!.payload,
        limits: { ...state.definition!.payload.limits, maxGroups: 2 } } } }
      expect(checkGroupAdmission(availableSender, group)?.reason).toBe('work-group-incoming-quota')
      const snapshots = []
      for (const member of spec.members) {
        const session = await repository.open(member.sessionId), snapshot = session.snapshot(), agent = projectAgentSession(snapshot)
        snapshots.push(snapshot)
        expect(agent.roots).toHaveLength(1); expect(agent.turns).toHaveLength(scenario === 'unclaimed' && member.agentKey !== 'writer' ? 1 : 2)
        expect(agent.roots[0]?.budget).toMatchObject({ messages: member.agentKey === 'writer' ? 3 : 0,
          waits: scenario === 'unclaimed' && member.agentKey !== 'writer' ? 0 : 1 })
        expect(agent.inputs.filter(input => input.workMessage?.kind === 'group').map(input => input.status)).toEqual(member.agentKey === 'writer' ? [] : [scenario === 'unclaimed' ? 'not-adopted' : 'handled'])
        if (member.agentKey !== 'writer') continue
        const events = snapshot.history.at(-1)!.events, intent = events.find(event => event.stored.type === workGroupRequestedEvent.type)!
        const result = events.find(event => event.stored.type === workGroupResultEvent.type)!
        expect(workGroupResultEvent.decode(result.stored.payload).recipients.map(item => item.status)).toEqual(['delivered', 'delivered', 'delivered'])
        const sends = projectCommunicationFacts(snapshot).outbox.filter(item => item.envelope.type === 'workflow/group')
        expect(sends.map(item => item.sendKey)).toEqual([0, 1, 2].map(index => ({ eventId: intent.stored.eventId, index })))
        const count = events.find(event => event.stored.type === 'agent/action-settled')!.stored.sequence
        const prefix = await recoverWorkPrefix(snapshot, count, spec.storage.maxRecordBytes)
        expect(prefix.state.roots).toHaveLength(1)
        expect(prefix.state.roots[0]?.budget.messages).toBe(3)
        expect(prefix.added.some(event => event.stored.type === 'communication/outbox-accepted')).toBe(false)
      }
      for (const mode of scenario === 'unclaimed' ? [] : ['offline', 'lost-receipt', 'deadline', 'pre-send-timeout', 'cancel-after-result'] as const) {
        const branch = await groupDeliveryBranch(coordinator.snapshot(), snapshots, spec.storage.maxRecordBytes, mode)
        if (mode === 'pre-send-timeout') {
          expect(branch.result).toMatchObject({ outcome: 'timed-out', recipients: [{ status: 'abandoned' }, { status: 'abandoned' }, { status: 'abandoned' }] })
          expect(branch.outbox).toHaveLength(0); expect(branch.received).toEqual([0, 0, 0]); continue
        }
        expect(branch.result.recipients.map(item => item.status)).toEqual(['delivered', 'rejected', mode === 'lost-receipt' ? 'outcome-unknown' : 'abandoned'])
        expect(branch.result.outcome).toBe(mode === 'deadline' ? 'timed-out' : completion === 'all-delivered' ? 'failed' : 'completed')
        expect(branch.received).toEqual([1, 0, mode === 'lost-receipt' ? 1 : 0])
        expect(branch.outbox[1]).toMatchObject({ status: 'rejected', rejection: 'receive-forbidden' })
        if (mode === 'cancel-after-result') {
          expect(branch.agent.roots[0]?.outcome).toBe('cancelled')
          expect(branch.agent.inputs.filter(input => input.workGroupResult !== undefined).map(input => input.status)).toEqual(['not-adopted'])
          expect(branch.agent.waits[0]?.settled?.payload.outcome).toBe('cancelled')
        }
      }
    } finally { await repository.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)

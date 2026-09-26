import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { groupWorkflowHost } from './group-fixture.js'
import { initializeHost } from '../../src/host/initialization.js'
import { assembleHost } from '../../src/host/assembly.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { systemClock } from '../../src/foundation/clock.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { resolveDirectoryReceiver } from '../../src/communication/directory.js'

it.each(['late-question', 'late-group', 'queued-question', 'queued-group'] as const)('disposes %s when cancellation reaches a participant before its root starts', async scenario => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-stopped-message-'))
  try {
    const base = groupWorkflowHost(directory), entry = base.workflows.definitions[0]!
    const actions = ['agent_ask_work_peer', 'agent_answer_work_peer', 'agent_send_work_group', 'agent_await_work_message'] as const
    const members = base.members.map(member => ({ ...member, spec: { ...member.spec, workflow: { ...member.spec.workflow, nativeActions: actions } } }))
    const definition = decodeWorkflowDefinition({ ...entry.definition,
      roster: entry.definition.roster.map((member, index) => ({ ...member, ...workflowMemberFingerprints(members[index]!) })),
      communication: { ...entry.definition.communication, ask: [{ from: 'writer', to: 'reviewer' }] },
      limits: { ...entry.definition.limits, maxQuestions: 1, maxIncomingQuestions: 1 },
      nodes: entry.definition.nodes.map(node => ({ ...node, attempts: node.attempts.map(attempt => ({ ...attempt, nativeActions: actions })) })) })
    const spec = { ...base, members, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    const question = scenario.endsWith('question'), queued = scenario.startsWith('queued')
    const calls: string[] = []
    await initializeHost(spec)
    const assembly = await assembleHost(spec, systemClock, {}, { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* () {
        calls.push(member.agentKey)
        expect(member.agentKey).toBe('writer')
        const name = question ? 'agent_ask_work_peer' : 'agent_send_work_group'
        const args = question ? { targetNodeKey: 'write', text: 'Retain the original source.', timeoutMs: 60000 }
          : { targetNodeKeys: ['write'], text: 'Retain the original source.', timeoutMs: 60000, completion: 'collect-outcomes' }
        yield { kind: 'message-start', responseId: 'collaboration', reportedModel: member.spec.target.model }
        yield { kind: 'block-start', index: 0, block: 'tool-call', name, callId: 'collaboration' }
        yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(args) }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } }) })
    try {
      const domain = assembly.workflows!, coordinator = assembly.protocolSlots.find(slot => slot.member.agentKey === 'workflow:research')!
      async function maintain() {
        for (let step = 0; step < 100; step++) {
          const action = domain.nextAction()
          if (action === undefined) return
          await action()
        }
        throw new Error('maintenance did not settle within the fixed fixture budget')
      }
      const member = (key: string) => assembly.slots.find(slot => slot.member.agentKey === key)!
      await domain.control('research', 'resume', { requestKey: 'start' }); await maintain()
      expect(domain.report('research').counts.assignments).toBe(4)
      const task = (key: string) => coordinator.mailbox.snapshot().outbox.find(item => item.envelope.type === 'workflow/assignment'
        && item.envelope.recipient === member(key).session.header.address)!
      await coordinator.dispatcher.dispatch({ onlyMessageIds: new Set([task('writer').messageId]) }); await maintain()
      await member('writer').agent.start({ selection: member('writer').selection! }); await maintain()
      const outgoing = member('writer').mailbox.snapshot().outbox.find(item => item.envelope.type === (question ? 'workflow/question' : 'workflow/group'))!
      expect(outgoing.status).toBe('pending')
      if (queued) {
        await coordinator.dispatcher.dispatch({ onlyMessageIds: new Set([task('reviewer').messageId]) }); await maintain()
        await member('writer').dispatcher.dispatch({ onlyMessageIds: new Set([outgoing.messageId]) }); await maintain()
        expect(projectAgentSession(member('reviewer').session.snapshot()).inputs.find(input => input.workMessage !== undefined)?.status).toBe('queued')
      }
      await domain.control('research', 'cancel', { requestKey: 'stop' }); await maintain()
      const stop = coordinator.mailbox.snapshot().outbox.find(item => item.envelope.type === 'workflow/stop' && item.envelope.recipient === member('reviewer').session.header.address)!
      await coordinator.dispatcher.dispatch({ onlyMessageIds: new Set([stop.messageId]) }); await maintain()
      if (!queued) {
        const receiver = resolveDirectoryReceiver(assembly.directory, outgoing.envelope.recipient).receiver!
        expect((await receiver.acceptDelivery(outgoing.envelope, outgoing.envelope.sender, new AbortController().signal)).kind).toBe('accepted')
        await maintain()
      }
      const peer = member('reviewer'), state = projectAgentSession(peer.session.snapshot())
      expect(state.roots).toHaveLength(0)
      expect(calls).toEqual(['writer'])
      expect(state.inputs.filter(input => input.workMessage !== undefined).every(input => input.status === 'not-adopted')).toBe(true)
      expect(peer.mailbox.snapshot().inbox.every(item => item.status !== 'pending')).toBe(true)
      if (!queued) expect(peer.session.snapshot().history.at(-1)!.events.some(item => item.stored.type === 'work/stopped-message')).toBe(true)
      if (question) expect(peer.mailbox.snapshot().outbox.filter(item => item.envelope.type === 'workflow/answer').map(item => item.envelope.payload))
        .toMatchObject([{ outcome: 'unavailable', questionMessageId: outgoing.messageId, text: 'work-root-terminal' }])
    } finally { await assembly.dispose() }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30000)

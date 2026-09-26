import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame, ModelRequest } from '../../src/model/contract.js'
import { SessionRepository } from '../../src/session/repository.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { parseSessionId } from '../../src/session/ids.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { projectCommunicationFacts } from '../../src/communication/projection.js'
import { runnableWorkflowHost } from './host-fixture.js'
import { recoverWorkPrefix } from './prefix-fixture.js'
import { workQuestionRequestedEvent, workInteractionResolvedEvent } from '../../src/workflow/interaction-events.js'
import { checkWorkflowInteraction } from '../../src/workflow/interactions.js'
import { AgentJournal } from '../../src/agent/journal.js'
import { agentControlRequestedEvent, workflowActionSettledEvent } from '../../src/agent/session-events.js'

function questionInput(request: ModelRequest) {
  for (const message of request.messages) for (const block of message.content) {
    if (block.kind !== 'text') continue
    let value
    try { value = JSON.parse(block.text) as { kind?: string; data?: { messageId?: string } } } catch { continue }
    if (value.kind === 'workflow-question') return value.data!.messageId!
  }
  throw new Error('claimed question is absent from request')
}

it.each(['answer', 'decline', 'unanswered', 'cycle', 'automatic', 'timeout'] as const)('settles %s inside the two original work roots', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'work-question-'))
  try {
    const base = runnableWorkflowHost(root)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('v3 fixture')
    const entry = base.workflows.definitions[0]!
    const actions = ['agent_ask_work_peer', 'agent_await_work_message', 'agent_answer_work_peer', 'agent_ask_user'] as const
    const grant = { models: 5, steps: 5, tools: 0, messages: 3, waits: 3, outputTokens: 1280 }
    const members = base.members.map(member => {
      if (member.kind !== 'local' || member.spec.protocolVersion !== 3) throw new Error('v3 local fixture')
      return { ...member, model: { ...member.model, runnerLimits: { ...member.model.runnerLimits, maxToolCalls: 1 } },
        spec: { ...member.spec, budget: grant, workflow: { kind: 'participant' as const, toolNames: [], resourceIds: [], nativeActions:
          scenario === 'automatic' && member.agentKey === 'writer' ? actions.filter(name => name !== 'agent_answer_work_peer') : actions } } }
    })
    const definition = decodeWorkflowDefinition({ ...entry.definition,
      budget: { ...grant, models: 10, steps: 10, messages: 6, waits: 6, outputTokens: 2560 },
      limits: { ...entry.definition.limits, maxQuestions: 1, maxIncomingQuestions: 1, maxProtocolMessages: 16 },
      communication: { ...entry.definition.communication, ask: [{ from: 'reviewer', to: 'writer' }, { from: 'writer', to: 'reviewer' }] },
      roster: entry.definition.roster.map((member, index) => ({ ...member, ...workflowMemberFingerprints(members[index]!), budgetCeiling: grant })),
      nodes: entry.definition.nodes.map(node => ({ ...node, dependencies: [], inputs: [], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        attempts: node.attempts.map(attempt => ({ ...attempt, workerGrant: grant, nativeActions: members.find(member => member.agentKey === node.executor)!.spec.workflow.nativeActions })) })) })
    const spec = { ...base, members, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    await initializeHost(spec)
    let tick = Date.now()
    const calls = new Map<string, number>()
    const host = await openHost(spec, { clock: { now: () => tick }, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission): AsyncGenerator<ModelFrame> {
        const count = (calls.get(member.agentKey) ?? 0) + 1
        calls.set(member.agentKey, count)
        const receiver = member.agentKey === (scenario === 'cycle' ? 'reviewer' : 'writer')
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: member.agentKey + count }
        const name = count === 1 ? receiver ? scenario === 'cycle' ? 'agent_ask_work_peer' : scenario === 'automatic' || scenario === 'timeout' ? 'agent_ask_user' : 'agent_await_work_message' : 'agent_ask_work_peer'
          : receiver && scenario === 'cycle' && count === 2 ? 'agent_await_work_message'
            : receiver && count === (scenario === 'cycle' ? 3 : 2) && scenario !== 'automatic' && scenario !== 'unanswered' && scenario !== 'timeout' ? 'agent_answer_work_peer' : undefined
        if (name !== undefined) {
          if (scenario === 'cycle' && receiver && count === 2) expect(JSON.stringify(submission.request)).toContain('work-wait-cycle')
          const args = name === 'agent_await_work_message' ? { kind: 'question', timeoutMs: 60000 }
            : name === 'agent_ask_user' ? { question: 'Confirm source?', timeoutMs: 60000 }
              : name === 'agent_ask_work_peer' ? { targetNodeKey: member.agentKey === 'writer' ? 'write' : 'read', text: 'Which source supports the result?', timeoutMs: scenario === 'timeout' ? 1000 : 60000 }
                : { questionMessageId: questionInput(submission.request), outcome: scenario === 'decline' ? 'declined' : 'answered', text: 'Source 3 supports it.' }
          yield { kind: 'block-start', index: 0, block: 'tool-call', name, callId: name + count }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(args) }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          if (scenario === 'timeout' && receiver) expect(JSON.stringify(submission.request)).not.toContain('Which source supports the result?')
          if (!receiver) expect(JSON.stringify(submission.request)).toContain(scenario === 'automatic' ? 'work-answer-unavailable' : scenario === 'unanswered' ? 'work-root-terminal' : 'Source 3 supports it.')
          yield { kind: 'block-start', index: 0, block: 'text' }
          yield { kind: 'text-delta', index: 0, text: member.agentKey === 'writer' ? '{"text":"accepted upstream"}' : 'final report' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } }) } })
    try {
      host.pause('writer'); host.pause('reviewer')
      await host.workflow('research').resume({ requestKey: 'question' })
      await host.run()
      expect(host.workflow('research').report().counts.assignments).toBe(2)
      host.resume('writer')
      await host.run()
      host.resume('reviewer')
      let run = await host.run()
      if (scenario === 'timeout') { tick += 2000; await host.run(); expect(calls.get('reviewer')).toBe(1) }
      if (scenario === 'automatic' || scenario === 'timeout') {
        expect(calls.get('writer')).toBe(1)
        const wait = host.report().members.find(member => member.agentKey === 'writer')!.agent.waits[0]!
        await host.submitAnswer('writer', wait.reference, 'Confirmed')
        run = await host.run()
      }
      expect(host.workflow('research').report(), JSON.stringify(run)).toMatchObject({ state: scenario === 'timeout' ? 'failed' : 'completed', closed: true, counts: { assignments: 2, accepted: scenario === 'timeout' ? 1 : 2 } })
    } finally { await host.shutdown() }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const coordinator = await repository.open(parseSessionId(entry.sessionId))
      const state = projectWorkflowSession(coordinator.snapshot())
      expect(state.interactions).toHaveLength(1)
      expect(state.interactions[0]?.settled?.payload.outcome).toBe(scenario === 'timeout' ? 'timed-out' : ['automatic', 'unanswered', 'decline'].includes(scenario) ? 'declined' : 'answered')
      if (scenario === 'answer') {
        const admitted = state.interactions[0]!.admitted.payload
        if (admitted.kind !== 'question') throw new Error('question fixture')
        expect(checkWorkflowInteraction(state, admitted)?.reason).toBe('work-peer-unavailable')
        const open = { ...state, decisions: [] }
        expect(checkWorkflowInteraction(open, admitted)?.reason).toBe('work-question-quota')
        const moreOutgoing = { ...open, definition: { ...state.definition!, payload: { ...state.definition!.payload,
          limits: { ...state.definition!.payload.limits, maxQuestions: 2 } } } }
        expect(checkWorkflowInteraction(moreOutgoing, admitted)?.reason).toBe('work-question-quota')
        const denied = { ...open, definition: { ...state.definition!, payload: { ...state.definition!.payload,
          communication: { ...state.definition!.payload.communication, ask: [] } } } }
        expect(checkWorkflowInteraction(denied, admitted)?.reason).toBe('work-question-not-permitted')
      }
      for (const member of members) {
        const session = await repository.open(parseSessionId(member.sessionId))
        const agent = projectAgentSession(session.snapshot())
        expect(agent.roots).toHaveLength(1)
        expect(agent.turns).toHaveLength(scenario === 'timeout' && member.agentKey === 'reviewer' ? 1 : 2)
        expect(agent.roots[0]?.budget).toMatchObject({ waits: scenario === 'cycle' && member.agentKey === 'reviewer' ? 2 : 1,
          messages: ['automatic', 'unanswered', 'timeout'].includes(scenario) && member.agentKey === 'writer' ? 0 : scenario === 'cycle' && member.agentKey === 'reviewer' ? 2 : 1 })
        const sends = projectCommunicationFacts(session.snapshot()).outbox.filter(item => ['workflow/question', 'workflow/answer'].includes(item.envelope.type))
        expect(sends).toHaveLength(1)
        expect(sends[0]?.status).toBe('delivered')
        if (scenario === 'answer' && member.agentKey === 'writer') {
          const snapshot = session.snapshot()
          const settled = snapshot.history.at(-1)!.events.find(event => event.stored.type === 'agent/action-settled')!
          const payload = workflowActionSettledEvent.decode(settled.stored.payload)
          const recovered = await recoverWorkPrefix(snapshot, settled.stored.sequence - 1, spec.storage.maxRecordBytes, async copied => {
            const journal = new AgentJournal(copied, 4, { now: () => tick })
            await journal.append(agentControlRequestedEvent, () => ({ kind: 'cancel-work' as const, root: agent.roots[0]!.id, reason: 'operator-cancel' }))
            await journal.append(workflowActionSettledEvent, () => payload)
          })
          expect(recovered.result.kind).toBe('recovered')
          expect(recovered.state.roots[0]?.outcome).toBe('cancelled')
          expect(recovered.state.waits[0]?.settled?.payload.outcome).toBe('cancelled')
        }
        if (scenario === 'cycle' && member.agentKey === 'reviewer') {
          const blocked = session.snapshot().history.at(-1)!.events.find(event => event.kind === 'known' && event.stored.type === workInteractionResolvedEvent.type
            && workInteractionResolvedEvent.decode(event.payload).outcome === 'blocked')!
          const value = workInteractionResolvedEvent.decode(blocked.stored.payload)
          expect(value.outcome === 'blocked' && value.cycle.map(ref => ref.eventId)).toEqual([
            state.assignments[1]!.stored.eventId, state.assignments[0]!.stored.eventId, state.assignments[1]!.stored.eventId,
          ])
        }
        if (scenario === 'answer' && member.agentKey === 'reviewer') {
          const snapshot = session.snapshot(), events = snapshot.history.at(-1)!.events
          const question = events.find(event => event.stored.type === workQuestionRequestedEvent.type)!
          const resolved = events.find(event => event.stored.type === workInteractionResolvedEvent.type)!
          const checkpoint = events.find(event => event.stored.type === 'agent/turn-settled')!
          const outbox = sends[0]!
          for (const count of [question.stored.sequence - 1, question.stored.sequence, resolved.stored.sequence, resolved.stored.sequence + 1, checkpoint.stored.sequence,
            events.find(event => event.stored.eventId === outbox.acceptedEventId)!.stored.sequence]) {
            const recovered = await recoverWorkPrefix(snapshot, count, spec.storage.maxRecordBytes)
            expect(['recovered', 'nothing-to-recover']).toContain(recovered.result.kind)
            expect(recovered.state.actions[0]?.payload.result.kind).toBe(count < resolved.stored.sequence ? 'not-started' : 'wait')
            expect(recovered.state.roots).toHaveLength(1)
            expect(recovered.state.roots[0]?.budget).toMatchObject({ messages: 1, waits: 1 })
            expect(recovered.added.some(event => ['model/invocation-prepared', 'communication/outbox-accepted', 'artifact/published'].includes(event.stored.type))).toBe(false)
          }
        }
      }
    } finally { await repository.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 45000)

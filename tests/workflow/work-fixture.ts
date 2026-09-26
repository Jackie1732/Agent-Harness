import { workflowMessageDefinitions } from '../../src/workflow/messages.js'
import { WorkflowJournal } from '../../src/workflow/journal.js'
import { workflowProtocolRecordedEvent, workflowSourceCommands } from '../../src/workflow/protocol.js'
import { SessionAgent, SessionContext, SessionModelRunner, installAgentSpec, createMessageCatalog,
  agentSessionEventDefinitions, subagentSessionEventDefinitions, communicationSessionEventDefinitions, toolSessionEventDefinitions,
  ScriptedModelProvider, parseSessionId, parseChannelId } from '../../src/index.js'
import type { AgentSpecV3, JsonObject, ModelFrame } from '../../src/index.js'
import { snapshotJson } from '../../src/foundation/json.js'
import { workAssignmentAcceptedEvent } from '../../src/workflow/work-binding.js'
import { WorkflowAdmission } from '../../src/workflow/admission.js'
import { workflowDefinitionRecordedEvent, workflowSessionEventDefinitions } from '../../src/workflow/session-events.js'
import { AgentJournal } from '../../src/agent/journal.js'
import { agentSpec, clock } from '../agent/fixtures.js'
import { repository, profile, runnerLimits } from '../context/fixtures.js'
import { createCommunicationService } from '../communication/fixtures.js'
import { workflowFixture } from './fixtures.js'

export async function workFixture(actions = false, models = 2, output?: import('../../src/workflow/types.js').WorkflowOutput, finalText = '{"text":"work result"}', maxMessageBytes = 128 * 1024) {
  let calls = 0
  const provider = new ScriptedModelProvider({ providerId: 'work-model', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    script: async function* (): AsyncGenerator<ModelFrame> {
      calls++
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: `result-${calls}` }
      if (actions && calls === 1) {
        yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'ask' }
        yield { kind: 'arguments-delta', index: 0, text: '{"question":"Which source?","timeoutMs":1000}' }
      } else {
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: finalText }
      }
      yield { kind: 'block-end', index: 0 }
      yield { kind: 'complete', stopReason: actions && calls === 1 ? 'tool-calls' : 'stop' }
    } })
  const repo = repository(undefined, [...agentSessionEventDefinitions, ...subagentSessionEventDefinitions,
    ...communicationSessionEventDefinitions, ...toolSessionEventDefinitions, ...workflowSessionEventDefinitions])
  const session = await repo.create({ sessionId: parseSessionId('87000000-0000-4000-8000-000000000002') })
  const coordinator = await repo.create({ sessionId: parseSessionId('87000000-0000-4000-8000-000000000001') })
  const catalog = createMessageCatalog(workflowMessageDefinitions)
  const context = new SessionContext({ session, messageCatalog: catalog })
  const recorded = await context.recordProfile(profile('generation', { rendererVersion: 'context-neutral/v4' }))
  const spec: AgentSpecV3 = { ...agentSpec(recorded.stored.eventId, provider), protocolVersion: 3,
    context: { history: { mode: 'completed-roots', maxRoots: 5 }, memory: { required: [], query: { requiredTags: [], queryTags: [], topK: 5 } }, compactions: [] },
    subagents: { role: 'none' }, workflow: { kind: 'participant', toolNames: [], nativeActions: ['agent_ask_user'], resourceIds: [] } }
  await installAgentSpec(session, spec, clock)
  const { service, policy } = createCommunicationService({ maxMessageBytes, maxPendingInbox: 128, maxPendingOutbox: 128 })
  const sender = await service.attach(coordinator, { catalog, policy })
  const receiver = await service.attach(session, { catalog, policy })
  const agent = new SessionAgent({ session, context, model: new SessionModelRunner({ session, provider, limits: runnerLimits }),
    mailbox: receiver, messageCatalog: catalog, clock })
  const base = workflowFixture()
  const grant = { models, steps: 2, tools: 0, messages: 0, waits: 1, outputTokens: 512 }
  const recipe = { ...base, budget: { ...base.budget, outputTokens: 2048 },
    roster: base.roster.map(member => ({ ...member, budgetCeiling: grant })),
    nodes: base.nodes.map(node => ({ ...node, ...(output === undefined ? {} : { output }), attempts: node.attempts.map(attempt => ({ ...attempt, workerGrant: grant,
      nativeActions: actions ? ['agent_ask_user'] : [] })) })) }
  const saved = await coordinator.append(workflowDefinitionRecordedEvent, { definition: recipe })
  const journal = new AgentJournal(session, 4, clock)
  async function assign() {
    const work = await new WorkflowAdmission(coordinator, service.protocolCapacity, clock).admitRoot('read', session,
      parseChannelId('71000000-0000-4000-8000-000000000101'), () => undefined)
    const payload = snapshotJson({ definition: { address: coordinator.header.address, eventId: saved.stored.eventId },
      assignment: { address: coordinator.header.address, eventId: work.stored.eventId }, recipe, value: work.payload }) as JsonObject
    service.workflowChannels.bind(coordinator, work.stored.eventId, session)
    const command = await new WorkflowJournal(coordinator, clock).append(workflowProtocolRecordedEvent, () => workflowSourceCommands(
      new Map(coordinator.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known').map(item => [item.stored.eventId, item])), work.stored.eventId))
    const send = command.payload.commands[0]!
    if (send.kind !== 'send') throw new Error('Expected send')
    await sender.sendOnce({ eventId: command.stored.eventId, index: 0 }, send.request, send)
    await service.createDispatcher(sender).dispatch()
    const inbox = receiver.snapshot().inbox[0]!
    const accepted = await journal.append(workAssignmentAcceptedEvent, () => workAssignmentAcceptedEvent.decode({ ...payload, inbox: inbox.acceptedEventId }))
    return accepted
  }
  return { repo, session, coordinator, provider, agent, journal, context, spec, assign, sender, receiver, service, recipe, saved, calls: () => calls,
    close: async () => { await agent.dispose(); await service.dispose(); await provider.dispose(); await repo.dispose() } }
}

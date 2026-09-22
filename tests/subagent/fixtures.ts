import type { AgentSpecV2 } from '../../src/agent/contract.js'
import { AgentJournal } from '../../src/agent/journal.js'
import { SessionAgent, installAgentSpec } from '../../src/agent/session-agent.js'
import { agentSessionEventDefinitions } from '../../src/agent/session-events.js'
import { communicationSessionEventDefinitions } from '../../src/communication/session-events.js'
import { createChannelId } from '../../src/communication/ids.js'
import { SessionContext } from '../../src/context/session-context.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { formatSessionAddress, parseSessionId } from '../../src/session/ids.js'
import type { DelegationRequested } from '../../src/subagent/event-contract.js'
import { reserveDelegationBudget, delegationDeadline } from '../../src/subagent/budget.js'
import { decodeChildTemplate } from '../../src/subagent/template.js'
import { subagentSessionEventDefinitions } from '../../src/subagent/session-events.js'
import { toolSessionEventDefinitions } from '../../src/tool/session-events.js'
import { agentFixture, clock, observedAt } from '../agent/fixtures.js'
import { emptyMessageCatalog, profile, repository, runnerLimits } from '../context/fixtures.js'

export async function delegationFixture() {
  const provider = new ScriptedModelProvider({ providerId: 'delegation-fixture', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
    script: async function* (): AsyncGenerator<ModelFrame> {
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'response' }
      yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'question', name: 'agent_ask_user' }
      yield { kind: 'arguments-delta', index: 0, text: '{"question":"Which format?","timeoutMs":10000}' }
      yield { kind: 'block-end', index: 0 }
      yield { kind: 'complete', stopReason: 'tool-calls' }
    } })
  const base = await agentFixture({}, provider)
  const repo = repository(undefined, [...agentSessionEventDefinitions, ...subagentSessionEventDefinitions,
    ...toolSessionEventDefinitions, ...communicationSessionEventDefinitions])
  const session = await repo.create()
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
  const installedProfile = await context.recordProfile(profile('generation', { rendererVersion: 'context-neutral/v3' }))
  const grant = { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }
  const capabilities = { models: [{ providerId: provider.descriptor.providerId, model: 'fixture-model' }], tools: [], workspaces: [] }
  const spec: AgentSpecV2 = { ...base.spec, protocolVersion: 2, profileEventId: installedProfile.stored.eventId,
    nativeActions: ['agent_ask_user', 'agent_spawn_subagent'], budget: { models: 8, steps: 8, tools: 2, messages: 10, waits: 8, outputTokens: 2048 },
    subagents: { role: 'parent', templates: [{ templateKey: 'research', templateVersion: 1 }], capabilities, maxDelegations: 3, maxGrant: grant } }
  await installAgentSpec(session, spec, clock)
  const journal = new AgentJournal(session, 4, clock)
  const model = new SessionModelRunner({ session, provider, limits: runnerLimits })
  const agent = new SessionAgent({ session, model, context, messageCatalog: emptyMessageCatalog, clock })
  await agent.submitInput({ kind: 'task', text: 'Research a bounded question', originLabel: 'test' })
  const driven = await agent.start()
  if (driven.roots[0]?.outcome !== null || driven.waits.length !== 1) throw new Error(`fixture did not reach waiting: ${driven.roots[0]?.reason}`)
  const { profileEventId: _profile, ...childSpec } = base.spec
  const template = decodeChildTemplate({ templateKey: 'research', templateVersion: 1,
    profile: profile('generation', { rendererVersion: 'context-neutral/v3' }),
    spec: { ...childSpec, protocolVersion: 2, nativeActions: ['agent_ask_parent', 'agent_report_progress'], maxDirectSendCommandsPerSession: 0, budget: grant },
    model: { kind: 'scripted-fixed', providerId: provider.descriptor.providerId, text: 'result',
      maxConcurrentExchanges: 1, streamLimits: provider.descriptor.streamLimits, runnerLimits }, tools: { kind: 'none' }, capabilities,
    maxQuestions: 2, maxProgress: 1, limits: { maxUnresolvedDelegations: 4, maxActiveChildren: 4, maxChildDurationMs: 60000,
      maxProtocolStepsPerBatch: 8, maxRecoveryWrites: 20, maxRequestBytes: 16384, maxMaterialBytes: 2048,
      maxResultBytes: 8192, maxFileEntries: 8, maxProtocolConflicts: 4, maxDiscoveryEntries: 16 } })
  const root = agent.snapshot().roots[0]!
  const reserved = reserveDelegationBudget({ parentUsed: root.budget, parentLimit: spec.budget, requested: grant,
    templateCap: template.spec.budget, parentGrantCap: grant, parentMaxOutputTokens: 256, childMaxOutputTokens: 256, maxQuestions: 2, maxProgress: 1 })
  const childSessionId = parseSessionId('30000000-0000-4000-8000-000000000103')
  const deadline = delegationDeadline(root.deadline, observedAt, template.spec.rootDurationMs, 60000)
  const requested: DelegationRequested = { parentAddress: session.header.address, childAddress: formatSessionAddress(childSessionId), childSessionId,
    channelId: createChannelId(), parentRoot: root.id, source: { kind: 'programmatic', requestKey: 'request-1' },
    request: { templateKey: 'research', templateVersion: 1, task: 'Inspect evidence', materials: [], requestedBudget: grant, workspace: { kind: 'none' } },
    effectivePlan: { template, workspace: { kind: 'none' }, childBudget: grant, deadline }, grant,
    parentProtocolReserve: reserved.parentProtocolReserve, childProtocolReserve: reserved.childProtocolReserve,
    mailboxReserve: reserved.mailboxReserve, deadline, observedAt }
  return { base, repo, session, context, spec, journal, agent, template, requested,
    close: async () => { await agent.dispose(); await repo.dispose(); await base.close() } }
}

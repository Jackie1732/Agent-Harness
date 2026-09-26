import { SessionContext, toolSessionEventDefinitions, communicationSessionEventDefinitions } from '../../src/index.js'
import type { ModelProvider } from '../../src/model/contract.js'
import type { MessageCatalog } from '../../src/communication/message-catalog.js'
import type { SessionBackend } from '../../src/session/backend.js'
import type { AgentSpecV1 } from '../../src/agent/contract.js'
import { AgentJournal } from '../../src/agent/journal.js'
import * as events from '../../src/agent/session-events.js'
import { emptyMessageCatalog, profile, repository, scriptedModel } from '../context/fixtures.js'

export const clock = { now: () => 1_789_257_600_000 }
export const observedAt = new Date(clock.now()).toISOString()

export async function agentFixture(overrides: Partial<AgentSpecV1> = {}, providerInput?: ModelProvider, messageCatalog: MessageCatalog = emptyMessageCatalog, backend?: SessionBackend) {
  const repo = repository(backend, [...events.agentSessionEventDefinitions, ...toolSessionEventDefinitions, ...communicationSessionEventDefinitions])
  const session = await repo.create()
  const context = new SessionContext({ session, messageCatalog })
  const provider = providerInput ?? scriptedModel()
  const p = await context.recordProfile(profile('generation', { rendererVersion: 'context-neutral/v2' }))
  const spec = agentSpec(p.stored.eventId, provider, overrides)
  const journal = new AgentJournal(session, 4, clock)
  const installed = await journal.append(events.agentSpecRecordedEvent, () => spec)
  return { repo, session, context, provider, spec, journal, installed,
    close: async () => {
      const errors: unknown[] = []
      for (const resource of [context, provider, repo]) { try { await resource.dispose() } catch (error) { errors.push(error) } }
      if (errors.length > 0) throw new AggregateError(errors, 'fixture cleanup failed')
    } }
}

export async function openStep(f: Awaited<ReturnType<typeof agentFixture>>, text = 'claimed task') {
  const input = await f.journal.append(events.agentInputAcceptedEvent, () => ({ spec: f.installed.stored.eventId, input: { kind: 'task' as const, text, originLabel: 'test' } }))
  const run = await f.journal.append(events.agentRunStartedEvent, () => ({ spec: f.installed.stored.eventId, kind: 'drive' as const }))
  const turn = await f.journal.append(events.agentTurnStartedEvent, state => ({ run: run.stored.eventId, input: { kind: 'user' as const, eventId: input.stored.eventId },
    lane: 'user', ordinal: state.turns.length + 1, root: null, predecessor: null, deadline: null, observedAt }))
  const step = await f.journal.append(events.agentStepOpenedEvent, () => ({ turn: turn.stored.eventId, ordinal: 1, outputTokens: f.spec.target.maxOutputTokens, observedAt }))
  return { input, run, turn, step, consumer: { spec: f.installed.stored.eventId, run: run.stored.eventId, turn: turn.stored.eventId, step: step.stored.eventId } }
}

export function agentSpec(profileEventId: AgentSpecV1['profileEventId'], provider: ModelProvider, overrides: Partial<AgentSpecV1> = {}): AgentSpecV1 {
  return { protocolVersion: 1, label: 'test', responsibility: 'answer tasks', nonGoals: [], profileEventId: profileEventId,
    target: { model: 'fixture-model', maxOutputTokens: 256, provider: provider.descriptor }, toolNames: [], nativeActions: [], peers: [], messages: [],
    context: { history: { mode: 'none', maxRoots: 0 }, memory: { required: [], query: { requiredTags: [], queryTags: [], topK: 0 } }, compactions: [] },
    budget: { models: 5, steps: 5, tools: 5, messages: 5, waits: 5, outputTokens: 2048 }, rootDurationMs: 60_000,
    maxDirectSendCommandsPerSession: 5, errorFeedback: 'new-step', usagePolicy: 'observe-only', businessRefusalHandled: false,
    limits: { maxTurnsPerRun: 5, maxManagementPerRun: 20, maxDispatchRunsPerRun: 1, maxJournalConflicts: 4, maxReassemblies: 2,
      maxPendingInputs: 20, maxPendingWaits: 5, maxLanes: 10, maxInputBytes: 4096, maxActionsPerStep: 8, maxActionBytes: 4096,
      maxResultBytes: 16384, maxReportEntries: 100, maxWaitMs: 30_000 }, ...overrides }
}

import { describe, expect, it } from 'vitest'
import { collectExperimentMetrics } from '../../src/experiment/metrics.js'
import type { MetricsInput } from '../../src/experiment/metrics-types.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { modelPreparedEvent, modelStartedEvent, modelSettledEvent } from '../../src/model/session-events.js'
import { recoverModelInvocation } from '../../src/model/recovery.js'
import { parseModelInvocationId } from '../../src/model/ids.js'
import type { SessionSnapshot } from '../../src/session/types.js'
import { parseSessionId } from '../../src/session/ids.js'
import { assertJsonValue } from '../../src/foundation/json.js'
import { agentFixture, clock, openStep } from '../agent/fixtures.js'
import { agentControlRequestedEvent } from '../../src/agent/session-events.js'
import { recoverAgentSession } from '../../src/agent/recovery.js'
import { deferred, repository, request, runnerLimits, scripted, textFrames } from '../model/fixtures.js'

function input(snapshots: readonly SessionSnapshot[], overrides: Partial<MetricsInput> = {}): MetricsInput {
  return { snapshots, selectedSessionIds: snapshots.map(snapshot => snapshot.header.sessionId), scope: 'unit-local/v1', mode: 'fixture',
    maxMetricSamples: 128, coverage: { complete: true, expectedSessions: snapshots.length, observedSessions: snapshots.length, reasons: [] }, ...overrides }
}

describe('experiment execution metrics', () => {
  it('keeps prepared/started/settled/response observations distinct and reports every usage field independently', async () => {
    const repo = repository(), session = await repo.create(), provider = scripted()
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      await runner.invoke(request())
      const metrics = collectExperimentMetrics(input([session.snapshot()]))
      for (const name of ['model.prepared', 'model.started', 'model.settled', 'model.responseObserved'] as const) expect(metrics.counts[name].value).toBe(1)
      expect(metrics.tokens.inputTokens).toMatchObject({ total: 0, knownSubtotal: 0, observedCount: 1, knownCount: 1, eligibleCount: 1, ratio: 1, status: 'complete' })
      expect(metrics.tokens.outputTokens.total).toBe(4)
      expect(metrics.tokens.reasoningOutputTokens).toMatchObject({ total: null, knownSubtotal: 0, knownCount: 0, eligibleCount: 1, ratio: 0, status: 'incomplete' })
      expect(metrics.providers).toMatchObject([{ providerId: 'scripted', protocol: 'scripted', model: 'fixture-model' }])
      assertJsonValue(metrics)
      expect(metrics).toEqual(JSON.parse(JSON.stringify(metrics)))
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })

  it('retains partial counters without treating a truncated Provider stream as a complete total', async () => {
    const repo = repository(), session = await repo.create(), provider = scripted({ script: async function* (): AsyncGenerator<ModelFrame> {
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'partial' }
      yield { kind: 'usage', counts: { inputTokens: 7, outputTokens: 2, reasoningOutputTokens: 1 } }
    } })
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      await runner.invoke(request())
      const metrics = collectExperimentMetrics(input([session.snapshot()]))
      expect(metrics.tokens.inputTokens).toMatchObject({ total: null, knownSubtotal: 7, observedCount: 1, knownCount: 0, eligibleCount: 1, ratio: 0 })
      expect(metrics.tokens.outputTokens.knownSubtotal).toBe(2)
      expect(metrics.tokens.reasoningOutputTokens.knownSubtotal).toBe(1)
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })

  it('counts pending started work as eligible usage with unavailable counters', async () => {
    const repo = repository(), session = await repo.create(), entered = deferred(), release = deferred()
    const provider = scripted({ script: async function* () { entered.resolve(); await release.promise; yield* textFrames() } })
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits }), pending = runner.invoke(request())
    try {
      await entered.promise
      const metrics = collectExperimentMetrics(input([session.snapshot()]))
      expect(metrics.counts['model.started'].value).toBe(1)
      expect(metrics.counts['model.settled'].value).toBe(0)
      expect(metrics.tokens.inputTokens).toMatchObject({ total: null, knownSubtotal: 0, observedCount: 0, knownCount: 0, eligibleCount: 1, ratio: 0 })
    } finally { release.resolve(); await pending; await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })

  it('does not include definitely unissued or prepared-only work in the Provider denominator', async () => {
    const repo = repository(), session = await repo.create(), provider = scripted()
    try {
      const invocationId = parseModelInvocationId('10000000-0000-4000-8000-000000000101')
      await session.append(modelPreparedEvent, { invocationId, submission: provider.prepare(request()).submission, limits: runnerLimits })
      expect(collectExperimentMetrics(input([session.snapshot()])).tokens.outputTokens).toMatchObject({ total: 0, knownCount: 0, eligibleCount: 0, ratio: null })
      await recoverModelInvocation(session, { invocationId, predecessorStopped: true, maxJournalConflicts: 4 })
      const metrics = collectExperimentMetrics(input([session.snapshot()]))
      expect(metrics.counts['model.prepared'].value).toBe(1)
      expect(metrics.counts['model.started'].value).toBe(0)
      expect(metrics.counts['model.settled'].value).toBe(1)
      expect(metrics.tokens.inputTokens).toMatchObject({ total: 0, eligibleCount: 0, ratio: null, status: 'complete' })
    } finally { await provider.dispose(); await repo.dispose() }
  })

  it('includes a historically interrupted dispatch in the usage denominator', async () => {
    const repo = repository(), session = await repo.create(), provider = scripted()
    try {
      const invocationId = parseModelInvocationId('10000000-0000-4000-8000-000000000102')
      const submission = provider.prepare(request()).submission
      const prepared = await session.append(modelPreparedEvent, { invocationId, submission, limits: runnerLimits })
      await session.append(modelStartedEvent, { invocationId, preparedEventId: prepared.stored.eventId, fingerprint: submission.fingerprint })
      await recoverModelInvocation(session, { invocationId, predecessorStopped: true, maxJournalConflicts: 4 })
      const metrics = collectExperimentMetrics(input([session.snapshot()], { scope: 'historical-local/v1', mode: 'historical' }))
      expect(metrics.tokens.inputTokens).toMatchObject({ total: null, knownSubtotal: 0, knownCount: 0, eligibleCount: 1 })
      expect(metrics.scope).toBe('historical-local/v1')
    } finally { await provider.dispose(); await repo.dispose() }
  })

  it('never charges inherited calls to a Fork, and de-duplicates selected Session identities', async () => {
    const repo = repository(), parent = await repo.create(), provider = scripted()
    const runner = new SessionModelRunner({ session: parent, provider, limits: runnerLimits })
    try {
      await runner.invoke(request())
      const child = await repo.fork(parent.header.sessionId, parent.snapshot().localPosition)
      const metrics = collectExperimentMetrics(input([parent.snapshot(), child.snapshot()], { selectedSessionIds: [child.header.sessionId, child.header.sessionId] }))
      expect(metrics.counts['session.selected'].value).toBe(1)
      expect(metrics.counts['model.prepared'].value).toBe(0)
      expect(metrics.tokens.outputTokens.total).toBe(0)
      expect(metrics.counts['session.events'].basis.cuts).toEqual([{ address: child.header.address, through: child.snapshot().localPosition }])
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })

  it('preserves observed subtotals while incomplete evidence withholds whole-scope totals and ratios', async () => {
    const repo = repository(), session = await repo.create(), provider = scripted()
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      await runner.invoke(request())
      const absent = parseSessionId('00000000-0000-4000-8000-000000000299')
      const metrics = collectExperimentMetrics(input([session.snapshot()], { selectedSessionIds: [session.header.sessionId, absent],
        coverage: { complete: true, expectedSessions: 2, observedSessions: 1, reasons: [] } }))
      expect(metrics.coverage).toMatchObject({ complete: false, observedSessions: 1 })
      expect(metrics.counts['model.prepared']).toMatchObject({ value: null, knownSubtotal: 1, status: 'incomplete' })
      expect(metrics.tokens.outputTokens).toMatchObject({ total: null, knownSubtotal: 4, ratio: null })
      expect(metrics.coverage.reasons).toContain(`selected-session-missing:${absent}`)
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })

  it('bounds all report samples together without truncating exact counts or their cut-based derivation', async () => {
    const repo = repository(), session = await repo.create(), provider = scripted()
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      await runner.invoke(request())
      const metrics = collectExperimentMetrics(input([session.snapshot()], { maxMetricSamples: 2 }))
      const bases = [...Object.values(metrics.counts), ...Object.values(metrics.tokens), metrics.messageCausation].map(metric => metric.basis)
      expect(bases.reduce((sum, basis) => sum + basis.evidenceRefs.length, 0)).toBe(2)
      expect(metrics.counts['model.settled']).toMatchObject({ value: 1, status: 'complete', basis: { truncated: true, matchedEvents: 1 } })
      expect(metrics.tokens.outputTokens.total).toBe(4)
      expect(metrics.counts['model.settled'].basis.cuts[0]?.through).toBe(3)
      expect(collectExperimentMetrics(input([session.snapshot()], { maxMetricSamples: 0 })).counts['model.settled'].basis.evidenceRefs).toEqual([])
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })

  it('counts real recovery writes once across superseding owners and retains root/turn/step identities', async () => {
    const f = await agentFixture()
    try {
      const opened = await openStep(f), before = f.session.snapshot().localPosition
      const recovery = await f.journal.append(agentControlRequestedEvent, (_state, snapshot) => ({ kind: 'recovery' as const,
        targetRun: opened.run.stored.eventId, controls: [], through: snapshot.localPosition, predecessorStopped: true, supersedes: null, maxRecoveryWrites: 10 }))
      await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: recovery.stored.eventId, maxRecoveryWrites: 10, maxJournalConflicts: 4, clock })
      const metrics = collectExperimentMetrics(input([f.session.snapshot()]))
      expect(metrics.counts['agent.roots'].value).toBe(1)
      expect(metrics.counts['agent.turns'].value).toBe(1)
      expect(metrics.counts['agent.steps'].value).toBe(1)
      expect(metrics.counts['agent.rootsCompleted'].value).toBe(0)
      expect(metrics.counts['recovery.agentRequested'].value).toBe(2)
      expect(metrics.counts['recovery.agentSettled'].value).toBe(1)
      expect(metrics.counts['recovery.agentRestarted'].value).toBe(1)
      expect(metrics.counts['recovery.appendedEvents'].value).toBe(f.session.snapshot().localPosition - before)
    } finally { await f.close() }
  })

  it('exposes all complete Provider fields without summing overlapping token categories', async () => {
    const repo = repository(), session = await repo.create(), provider = scripted()
    try {
      const invocationId = parseModelInvocationId('10000000-0000-4000-8000-000000000103'), submission = provider.prepare(request()).submission
      const prepared = await session.append(modelPreparedEvent, { invocationId, submission, limits: runnerLimits })
      await session.append(modelStartedEvent, { invocationId, preparedEventId: prepared.stored.eventId, fingerprint: submission.fingerprint })
      await session.append(modelSettledEvent, { invocationId, outcome: 'completed', external: 'response-observed',
        cleanup: { status: 'complete', failedResources: 0 }, result: { blocks: [], protocolComplete: true, stopReason: 'stop', responseId: 'complete-fields', reportedModel: 'fixture-model',
          usage: { source: 'provider', completeness: 'complete', inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 3, reasoningOutputTokens: 4 } } })
      const metrics = collectExperimentMetrics(input([session.snapshot()]))
      expect(Object.fromEntries(Object.entries(metrics.tokens).map(([field, metric]) => [field, metric.total]))).toEqual({
        inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 3, reasoningOutputTokens: 4 })
      expect(metrics.unavailable.find(metric => metric.name === 'cost')).toBeDefined()
    } finally { await provider.dispose(); await repo.dispose() }
  })

  it('uses the whole eligible-call denominator when some settled calls have no usage fields', async () => {
    const repo = repository(), session = await repo.create()
    let calls = 0
    const provider = scripted({ script: async function* (): AsyncGenerator<ModelFrame> {
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: `call-${++calls}` }
      if (calls === 1) yield { kind: 'usage', counts: { inputTokens: 5, outputTokens: 7 } }
      yield { kind: 'complete', stopReason: 'stop' }
    } })
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      await runner.invoke(request()); await runner.invoke(request())
      const result = collectExperimentMetrics(input([session.snapshot()]))
      expect(result.tokens.inputTokens).toMatchObject({ total: null, knownSubtotal: 5, observedCount: 1, knownCount: 1, eligibleCount: 2, ratio: 0.5 })
      expect(result.tokens.outputTokens).toMatchObject({ total: null, knownSubtotal: 7, observedCount: 1, knownCount: 1, eligibleCount: 2, ratio: 0.5 })
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
})

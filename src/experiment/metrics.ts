import { projectAgentSession } from '../agent/projection.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import { projectModelSession } from '../model/projection.js'
import { projectToolSession } from '../tool/projection.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { communicationMetricFacts } from './metrics-communication.js'
import { executionMetricFacts } from './metrics-execution.js'
import { experimentCountMetricNames, modelUsageFields } from './metrics-types.js'
import type { CountMetric, ExperimentMetrics, MetricsBasis, MetricsCoverage, MetricsEventRef, MetricsInput, MetricsSessionFacts, ModelUsageField, TokenMetric } from './metrics-types.js'

/** Derive exact local counters and qualified usage from fixed snapshots without opening a Host or mutating evidence. */
export function collectExperimentMetrics(input: MetricsInput): ExperimentMetrics {
  const snapshots = new Map(input.snapshots.map(snapshot => [snapshot.header.sessionId, snapshot]))
  const selected = [...new Set(input.selectedSessionIds)].sort()
  const missing = selected.filter(id => !snapshots.has(id))
  const sessions: MetricsSessionFacts[] = selected.flatMap(id => {
    const snapshot = snapshots.get(id)
    if (snapshot === undefined) return []
    const events = snapshot.history.at(-1)!.events
    return [{ snapshot, events, model: projectModelSession(snapshot), tools: projectToolSession(snapshot), communication: projectCommunicationFacts(snapshot),
      agent: events.some(event => event.stored.type === 'agent/spec-recorded') ? projectAgentSession(snapshot) : null,
      workflow: events.some(event => event.stored.type === 'workflow/definition-recorded') ? projectWorkflowSession(snapshot) : null }]
  })
  const coverage: MetricsCoverage = { ...input.coverage, complete: input.coverage.complete && missing.length === 0,
    observedSessions: sessions.length, reasons: [...new Set([...input.coverage.reasons, ...missing.map(id => `selected-session-missing:${id}`)])].sort() }
  const execution = executionMetricFacts(sessions), communication = communicationMetricFacts(sessions)
  const cuts = sessions.map(session => ({ address: session.snapshot.address, through: session.snapshot.localPosition }))
  let remainingSamples = input.maxMetricSamples
  const basis = (rule: string, references: readonly MetricsEventRef[]): MetricsBasis => {
    const unique = [...new Map(references.map(ref => [`${ref.address}\u0000${ref.eventId}`, ref])).values()]
    const samples = unique.slice(0, remainingSamples)
    remainingSamples -= samples.length
    return { rule, cuts, evidenceRefs: samples, matchedEvents: unique.length, truncated: samples.length < unique.length }
  }
  const factGroups = new Map(experimentCountMetricNames.map(name => [name, { value: 0, refs: [] as MetricsEventRef[] }]))
  for (const fact of [...execution.counts, ...communication.counts]) {
    const aggregate = factGroups.get(fact.name)!
    aggregate.value += fact.value
    for (const ref of fact.refs) aggregate.refs.push(ref)
  }
  const counts = Object.fromEntries(experimentCountMetricNames.map(name => {
    const fact = factGroups.get(name)!
    const metric: CountMetric = { definitionVersion: 'event-count/v1', scope: input.scope, value: coverage.complete ? fact.value : null,
      knownSubtotal: fact.value, status: coverage.complete ? 'complete' : 'incomplete', coverage, basis: basis(`count/${name}/v1`, fact.refs) }
    return [name, metric]
  })) as Record<typeof experimentCountMetricNames[number], CountMetric>
  const tokens = Object.fromEntries(modelUsageFields.map(field => {
    let knownSubtotal = 0, observedCount = 0, knownCount = 0
    for (const fact of execution.usage) {
      const value = fact.usage?.[field]
      if (typeof value === 'number') {
        knownSubtotal += value
        observedCount++
        if (fact.usage?.completeness === 'complete') knownCount++
      }
    }
    const eligibleCount = execution.usage.length, complete = coverage.complete && knownCount === eligibleCount
    const metric: TokenMetric = { definitionVersion: 'provider-usage/v1', scope: input.scope, total: complete ? knownSubtotal : null,
      knownSubtotal, observedCount, knownCount, eligibleCount, ratio: coverage.complete && eligibleCount > 0 ? knownCount / eligibleCount : null,
      status: complete ? 'complete' : 'incomplete', coverage,
      basis: basis(`provider-usage/${field}/v1`, execution.usage.flatMap(fact => fact.refs)) }
    return [field, metric]
  })) as Record<ModelUsageField, TokenMetric>
  const cause = communication.causation, causeComplete = coverage.complete && cause.resolvedMessages === cause.uniqueMessages
  return { definitionVersion: 'experiment-metrics/v1', scope: input.scope, mode: input.mode, coverage, counts, tokens, providers: execution.providers,
    messageCausation: { definitionVersion: 'message-causation/v1', scope: input.scope,
      value: causeComplete && cause.uniqueMessages > 0 ? cause.maxDepth : null, knownSubtotal: cause.maxDepth,
      status: causeComplete ? 'complete' : 'incomplete', uniqueMessages: cause.uniqueMessages, resolvedMessages: cause.resolvedMessages,
      reasons: cause.reasons, coverage, basis: basis('explicit-causation-maximum-edge-count/v1', cause.refs) },
    unavailable: ([
      { name: 'latency.firstToken', reason: 'no-monotonic-first-token-observation' },
      { name: 'latency.network', reason: 'no-network-timing-boundaries' },
      { name: 'latency.queueWait', reason: 'no-persisted-queue-timing-boundaries' },
      { name: 'communication.channelBlockedDuration', reason: 'no-monotonic-channel-block-intervals' },
      { name: 'communication.networkDuplicateReceiveRequests', reason: 'receive-requests-are-not-persisted' },
      { name: 'intervention.humanOperatorOrigin', reason: 'management-controls-do-not-record-human-origin' },
      { name: 'resources.cpu', reason: 'no-resource-measurement' }, { name: 'resources.memory', reason: 'no-resource-measurement' },
      { name: 'cost', reason: 'no-frozen-price-table' },
    ] as const).map(metric => ({ ...metric, definitionVersion: 'unavailable/v1', scope: input.scope, value: null, knownSubtotal: null, status: 'unavailable',
      coverage, basis: basis(`unavailable/${metric.name}/v1`, []) })) }
}

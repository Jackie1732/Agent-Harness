import type { ModelUsage } from '../model/contract.js'
import type { SessionAddress, SessionId, SessionLogPosition } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import type { AgentSessionSnapshot } from '../agent/state.js'
import type { CommunicationFacts } from '../communication/types.js'
import type { ModelSessionSnapshot } from '../model/projection.js'
import type { ToolSessionSnapshot } from '../tool/projection.js'
import type { WorkflowSnapshot } from '../workflow/projection.js'
import type { SessionEventRecord } from '../session/types.js'

/** Local events of new experiment units and explicitly selected historical prefixes use separate scopes. */
export type MetricsScope = 'unit-local/v1' | 'historical-local/v1'
export type MetricsEventRef = WorkflowEventRef
export interface MetricsCutRef { readonly address: SessionAddress; readonly through: SessionLogPosition }
export interface MetricsCoverage {
  readonly complete: boolean
  readonly expectedSessions: number | null
  readonly observedSessions: number
  readonly reasons: readonly string[]
}
/** Ancestry may validate context sources; only selected Sessions contribute their own local events. */
export interface MetricsInput {
  readonly scope: MetricsScope
  readonly snapshots: readonly SessionSnapshot[]
  readonly selectedSessionIds: readonly SessionId[]
  readonly coverage: MetricsCoverage
  readonly mode: 'fixture' | 'live' | 'historical'
  readonly maxMetricSamples: number
}

export const experimentCountMetricNames = [
  'session.selected', 'session.events',
  'model.prepared', 'model.started', 'model.settled', 'model.responseObserved',
  'tool.requested', 'tool.allowed', 'tool.denied', 'tool.started', 'tool.executionObserved', 'tool.settled', 'tool.cleanupFailed',
  'agent.roots', 'agent.rootsCompleted', 'agent.turns', 'agent.turnsSettled', 'agent.steps', 'agent.stepsDecided',
  'agent.userWaits', 'agent.userAnswers', 'agent.managementControls', 'agent.waitsSettled',
  'communication.outboxAccepted', 'communication.inboxAccepted', 'communication.delivered', 'communication.inboxProcessed',
  'communication.outboxAbandoned', 'communication.inboxAbandoned', 'communication.attemptStarted', 'communication.retries',
  'communication.attemptFailed.recipient-offline', 'communication.attemptFailed.recipient-ending',
  'communication.attemptFailed.recipient-backpressure', 'communication.attemptFailed.attempt-interrupted',
  'communication.attemptFailed.receiver-outcome-unknown', 'communication.attemptFailed.transport-outcome-unknown',
  'communication.peerInputsClaimed', 'communication.modelMessageAdoptions',
  'communication.questionsAccepted', 'communication.answersAccepted', 'work.questionsDeclined', 'work.groups', 'work.groupUnicasts',
  'work.groupDelivered', 'work.groupRejected', 'work.groupAbandoned', 'work.groupOutcomeUnknown', 'work.businessDuplicates',
  'workflow.nodes', 'workflow.assignments', 'workflow.productionAttempts', 'workflow.proposals', 'workflow.reviews',
  'workflow.accepted', 'workflow.rejected', 'workflow.managementControls', 'workflow.paused', 'workflow.cancelled', 'workflow.closed',
  'subagent.requested', 'subagent.accepted', 'subagent.adopted', 'subagent.closed',
  'recovery.agentRequested', 'recovery.agentSettled', 'recovery.agentRestarted',
  'recovery.subagentRequested', 'recovery.subagentSettled', 'recovery.subagentRestarted',
  'recovery.workflowRequested', 'recovery.workflowSettled', 'recovery.workflowRestarted',
  'recovery.workRequested', 'recovery.workSettled', 'recovery.workRestarted', 'recovery.appendedEvents',
] as const
export type ExperimentCountMetricName = typeof experimentCountMetricNames[number]
export const modelUsageFields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'reasoningOutputTokens'] as const
export type ModelUsageField = typeof modelUsageFields[number]
export const experimentUnavailableMetricNames = [
  'latency.firstToken', 'latency.network', 'latency.queueWait', 'communication.channelBlockedDuration',
  'communication.networkDuplicateReceiveRequests', 'intervention.humanOperatorOrigin', 'resources.cpu', 'resources.memory', 'cost',
] as const

/** Fixed cuts and definition identify the full derivation; samples have a shared report-wide budget. */
export interface MetricsBasis {
  readonly rule: string
  readonly cuts: readonly MetricsCutRef[]
  readonly evidenceRefs: readonly MetricsEventRef[]
  readonly matchedEvents: number
  readonly truncated: boolean
}
export interface CountMetric {
  readonly definitionVersion: 'event-count/v1'
  readonly scope: MetricsScope
  readonly value: number | null
  readonly knownSubtotal: number
  readonly status: 'complete' | 'incomplete'
  readonly coverage: MetricsCoverage
  readonly basis: MetricsBasis
}
export interface TokenMetric {
  readonly definitionVersion: 'provider-usage/v1'
  readonly scope: MetricsScope
  readonly total: number | null
  readonly knownSubtotal: number
  readonly observedCount: number
  readonly knownCount: number
  readonly eligibleCount: number
  readonly ratio: number | null
  readonly status: 'complete' | 'incomplete'
  readonly coverage: MetricsCoverage
  readonly basis: MetricsBasis
}
export interface CausationMetric {
  readonly definitionVersion: 'message-causation/v1'
  readonly scope: MetricsScope
  readonly value: number | null
  readonly knownSubtotal: number
  readonly status: 'complete' | 'incomplete'
  readonly uniqueMessages: number
  readonly resolvedMessages: number
  readonly reasons: readonly string[]
  readonly coverage: MetricsCoverage
  readonly basis: MetricsBasis
}
export interface ExperimentMetrics {
  readonly definitionVersion: 'experiment-metrics/v1'
  readonly scope: MetricsScope
  readonly mode: MetricsInput['mode']
  readonly coverage: MetricsCoverage
  readonly counts: Readonly<Record<ExperimentCountMetricName, CountMetric>>
  readonly tokens: Readonly<Record<ModelUsageField, TokenMetric>>
  readonly providers: readonly { readonly providerId: string; readonly protocol: string; readonly adapterVersion: string; readonly endpoint: string; readonly model: string }[]
  readonly messageCausation: CausationMetric
  readonly unavailable: readonly UnavailableMetric[]
}
/** A named measurement has no source observations in this release. */
export interface UnavailableMetric {
  readonly name: typeof experimentUnavailableMetricNames[number]
  readonly definitionVersion: 'unavailable/v1'
  readonly scope: MetricsScope
  readonly value: null
  readonly knownSubtotal: null
  readonly status: 'unavailable'
  readonly reason: string
  readonly coverage: MetricsCoverage
  readonly basis: MetricsBasis
}

/** Intermediate facts remain internal to the pure metric derivation. */
export interface MetricCountFact { readonly name: ExperimentCountMetricName; readonly value: number; readonly refs: readonly MetricsEventRef[] }
export interface MetricUsageFact { readonly usage: ModelUsage | null; readonly refs: readonly MetricsEventRef[] }
export interface ExecutionMetricFacts {
  readonly counts: readonly MetricCountFact[]
  readonly usage: readonly MetricUsageFact[]
  readonly providers: ExperimentMetrics['providers']
}
export interface CommunicationMetricFacts {
  readonly counts: readonly MetricCountFact[]
  readonly causation: { readonly maxDepth: number; readonly uniqueMessages: number; readonly resolvedMessages: number;
    readonly reasons: readonly string[]; readonly refs: readonly MetricsEventRef[] }
}
export interface MetricsSessionFacts {
  readonly snapshot: SessionSnapshot
  readonly events: readonly SessionEventRecord[]
  readonly model: ModelSessionSnapshot
  readonly tools: ToolSessionSnapshot
  readonly communication: CommunicationFacts
  readonly agent: AgentSessionSnapshot | null
  readonly workflow: WorkflowSnapshot | null
}

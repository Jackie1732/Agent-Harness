import type { SessionEventId, SessionId } from '../session/ids.js'
import type { SessionProjectionCoverage, SessionSnapshot, CommittedSessionEvent } from '../session/types.js'
import type { ModelProviderDescriptor, ModelRequest, ModelRequestProfile, ModelToolDefinition } from '../model/contract.js'
import type { ModelInputPrecondition } from '../model/input-precondition.js'
import type { ModelInvocationId } from '../model/ids.js'
import type { MessageId } from '../communication/ids.js'
import type { ToolDefinition, ToolProviderDescriptor } from '../tool/contract.js'

/** Data references are never execution handles. Selectors are deliberately closed. */
export type ContextUnitSelector =
  | 'user-input' | 'assistant-response' | 'tool-exchange' | 'tool-observation'
  | 'peer-message' | 'outbox-message' | 'memory' | 'compacted-history' | 'legacy' | 'diagnostic'
export type ContextUnitReference = { readonly eventId: SessionEventId; readonly selector: ContextUnitSelector }
export type ContextTextReference =
  | { readonly eventId: SessionEventId; readonly selector: 'input-text' | 'tool-text' | 'inbox-text' | 'memory-text' | 'compaction-text' }
  | { readonly eventId: SessionEventId; readonly selector: 'model-text'; readonly outputBlockIndex: number }
export type ContextSourceReference = ContextUnitReference | ContextTextReference
export type ContextCut = { readonly coverage: readonly { readonly sessionId: SessionProjectionCoverage['sessionId']; readonly through: SessionProjectionCoverage['through'] }[] }

export type PromptSection = {
  readonly name: string
  readonly slot: 'rules' | 'task' | 'output'
  readonly ordinal: number
  readonly text: string
  readonly originLabel: string
}
export type ContextBudgetLimits = {
  readonly contextWindowTokens: number
  readonly outputReserveTokens: number
  readonly safetyMarginTokens: number
  readonly maxRequestBytes: number
  readonly maxAssemblyBytes: number
  readonly maxSourceEvents: number
  readonly maxSourceBytes: number
  readonly maxUnits: number
  readonly maxProvenanceEntries: number
  readonly maxMemoryCandidates: number
  readonly maxMemoryEstimatedTokens: number
  readonly maxJsonDepth: number
  readonly maxJsonNodes: number
  readonly minSavingsBytes: number
}
export type ContextTokenAccounting = {
  readonly mode: 'estimate-accepted' | 'exact-required'
  readonly algorithm: 'neutral-json-utf8-estimate/v1'
  readonly bytesPerEstimatedToken: number
  readonly fixedOverheadEstimate: number
}
export type ContextProfile = {
  readonly profileKey: string
  readonly purpose: 'generation' | 'compaction'
  readonly previousEventId: SessionEventId | null
  readonly sections: readonly PromptSection[]
  readonly toolNames: readonly string[]
  readonly rendererVersion: 'context-neutral/v1' | 'context-neutral/v2' | 'context-neutral/v3'
  readonly historyScope: 'local-only' | 'allow-lineage'
  readonly tokenAccounting: ContextTokenAccounting
  readonly budget: ContextBudgetLimits
}
export type ContextInput =
  | { readonly kind: 'user'; readonly origin: 'host-authored' | 'host-import'; readonly originLabel: string; readonly text: string }
  | { readonly kind: 'legacy-model-input'; readonly preparedEventId: SessionEventId; readonly fromMessage: number; readonly toMessage: number }

export type MemoryOrigin =
  | { readonly kind: 'host-authored' | 'host-import'; readonly originLabel: string; readonly relatedTo: readonly ContextSourceReference[] }
  | { readonly kind: 'verbatim'; readonly source: ContextTextReference }
  | { readonly kind: 'ancestor-adopted'; readonly source: ContextTextReference }
export type ContextMemoryRecord = {
  readonly key: string
  readonly previousEventId: SessionEventId | null
  readonly text: string
  readonly tags: readonly string[]
  readonly origin: MemoryOrigin
}
export type ContextMemoryRetraction = {
  readonly key: string
  readonly previousEventId: SessionEventId
  readonly reasonCode: 'caller-requested' | 'superseded' | 'incorrect'
}
export type ContextMemoryHead = {
  readonly key: string
  readonly headEventId: SessionEventId
  readonly record: CommittedSessionEvent<ContextMemoryRecord> | null
}
export type ContextMemoryQuery = {
  readonly requiredTags: readonly string[]
  readonly queryTags: readonly string[]
  readonly topK: number
}
export type ContextMemoryCandidate = {
  readonly reference: ContextUnitReference
  readonly key: string
  readonly score: number
  readonly matchedTags: readonly string[]
  readonly rank: number
  readonly withinTopK: boolean
}
export type ContextHistorySelection =
  | { readonly mode: 'local-suffix'; readonly representation: 'raw' | 'historical-note/v1' }
  | { readonly mode: 'lineage-suffix'; readonly representation: 'raw' | 'historical-note/v1'; readonly ancestorSessionIds: readonly SessionId[] }
export type ContextModelTarget = {
  readonly model: string
  readonly maxOutputTokens: number
  readonly temperature?: number
  readonly topP?: number
  readonly profile?: ModelRequestProfile
  readonly provider: ModelProviderDescriptor
}
export type InboxDisposition = { readonly messageId: MessageId; readonly action: 'include-full' | 'defer' }
export type CompactionSourceSelection = {
  readonly units: readonly ContextUnitReference[]
  readonly protectedRefs: readonly ContextUnitReference[]
}
export type ContextSelectionSpec = {
  readonly profileEventId: SessionEventId
  readonly target: ContextModelTarget
  readonly requiredInputs: readonly ContextUnitReference[]
  readonly observations: readonly ContextUnitReference[]
  readonly history: ContextHistorySelection
  readonly compactions: readonly SessionEventId[]
  readonly memory: { readonly required: readonly ContextUnitReference[]; readonly query: ContextMemoryQuery }
  readonly inbox: readonly InboxDisposition[]
  readonly outboxPayloads: readonly ContextUnitReference[]
  /** Non-null only for a purpose=compaction Profile. No tool or pending payload is implicit. */
  readonly compactionSource: CompactionSourceSelection | null
}

/** Safe observation of the explicit Registry, not a provider lease or an authorization. */
export type ContextToolSurface = {
  readonly definition: ToolDefinition
  readonly provider: ToolProviderDescriptor
  readonly model: ModelToolDefinition
}
export type ContextMessageSupport = { readonly type: string; readonly payloadVersion: number; readonly supported: boolean }
export type ContextCapturedFacts = {
  readonly tools: readonly ContextToolSurface[]
  readonly messageSupport: readonly ContextMessageSupport[]
}
export type ContextOmissionReason =
  | 'required-duplicate' | 'history-budget' | 'outside-suffix' | 'memory-top-k'
  | 'memory-budget' | 'request-budget' | 'compacted'
export type ContextOmission = { readonly reference: ContextUnitReference; readonly reason: ContextOmissionReason }
export type ContextSelectedUnit = {
  readonly reference: ContextUnitReference
  readonly sourceEventIds: readonly SessionEventId[]
  readonly placement: 'history' | 'required' | 'memory' | 'compaction-source'
  readonly representation: 'raw' | 'historical-note/v1' | 'data-note'
}
export type ContextDeferredInbox = {
  readonly messageId: MessageId
  readonly acceptedEventId: SessionEventId
  readonly sender: string
  readonly recipient: string
  readonly channelId: string
  readonly channelSequence: number
  readonly correlationId: string
  readonly causationId: string | null
  readonly replyTo: string | null
  readonly status: 'pending'
  readonly reason: 'not-selected-this-assembly'
}
export type ContextPendingOutbox = {
  readonly messageId: MessageId
  readonly acceptedEventId: SessionEventId
  readonly recipient: string
  readonly channelId: string
  readonly channelSequence: number
  readonly correlationId: string
  readonly causationId: string | null
  readonly replyTo: string | null
  readonly attemptCount: number
  readonly openAttempt: number | null
  readonly lastFailure: string | null
  readonly outcomeUnknown: boolean
}
export type ContextProvenanceSource =
  | { readonly kind: 'profile-section'; readonly eventId: SessionEventId; readonly name: string }
  | { readonly kind: 'tool-surface'; readonly name: string }
  | { readonly kind: 'inline-control'; readonly field: 'model' | 'maxOutputTokens' | 'temperature' | 'topP' | 'profile' }
  | { readonly kind: 'unit'; readonly reference: ContextUnitReference; readonly eventIds: readonly SessionEventId[]; readonly representation: 'raw' | 'historical-note/v1' | 'data-note' }
export type ContextProvenance = {
  readonly location: string
  readonly source: ContextProvenanceSource
  readonly sourceDigest: string
}
export type ContextBudgetReport = {
  readonly accounting: 'neutral-json-utf8-estimate/v1'
  readonly precision: 'estimate'
  readonly requestBytes: number
  readonly estimatedInputTokens: number
  readonly availableInputTokens: number
  readonly memoryEstimatedTokens: number
  /** Pure preflight uses the maximal timestamp width; actual committed bytes are separately measurable. */
  readonly assemblyEnvelopeUpperBoundBytes: number
  readonly sessionMaxRecordBytes: number
  readonly sourceEvents: number
  readonly sourceBytes: number
  readonly units: number
}
export type ContextAssembly = {
  readonly purpose: 'generation' | 'compaction'
  readonly coverage: readonly { readonly sessionId: SessionProjectionCoverage['sessionId']; readonly through: SessionProjectionCoverage['through'] }[]
  readonly selection: ContextSelectionSpec
  readonly captured: ContextCapturedFacts
  readonly required: readonly ContextUnitReference[]
  readonly selected: readonly ContextSelectedUnit[]
  readonly omitted: readonly ContextOmission[]
  readonly deferred: readonly ContextDeferredInbox[]
  readonly pendingOutbox: readonly ContextPendingOutbox[]
  readonly memoryCandidates: readonly ContextMemoryCandidate[]
  readonly budget: ContextBudgetReport
  readonly request: ModelRequest
  readonly provenance: readonly ContextProvenance[]
  /** Unknown versions remain readable; strict rebuild never guesses their algorithms. */
  readonly rendererVersion: string
  readonly requestDigest: string
}
export type ContextBlockedReason =
  | 'unsettled-execution' | 'incomplete-tool-exchange' | 'unsupported-message'
  | 'tool-unavailable' | 'estimator-unavailable' | 'history-unrepresentable'
export type ContextBuildFailure =
  | { readonly kind: 'blocked'; readonly reason: Exclude<ContextBlockedReason, 'incomplete-tool-exchange'>; readonly references: readonly ContextUnitReference[] }
  | { readonly kind: 'blocked'; readonly reason: 'incomplete-tool-exchange'; readonly references: readonly ContextUnitReference[]; readonly missingIntents: readonly import('../model/contract.js').ModelIntentReference[] }
  | { readonly kind: 'budget-exceeded'; readonly limit: 'request-bytes' | 'input-tokens' | 'assembly-bytes' | 'session-record-bytes'; readonly required: number; readonly available: number; readonly references: readonly ContextUnitReference[] }
  | { readonly kind: 'resource-limit'; readonly limit: 'source-events' | 'source-bytes' | 'json' | 'units' | 'provenance' | 'memory-candidates' | 'report'; readonly maximum: number }
export type ContextBuildResult = { readonly kind: 'ready'; readonly assembly: ContextAssembly; readonly request: ModelRequest } | ContextBuildFailure
export type CommittedContextBuildResult = {
  readonly kind: 'ready'
  readonly committed: CommittedSessionEvent<ContextAssembly>
  readonly request: ModelRequest
  readonly inputPrecondition: ModelInputPrecondition
  readonly committedEnvelopeBytes: number
} | ContextBuildFailure

export type ContextLoss =
  | { readonly kind: 'verbatim'; readonly reference: ContextUnitReference }
  | { readonly kind: 'excerpt'; readonly reference: ContextUnitReference; readonly fromByte: 0; readonly endByte: number; readonly originalBytes: number; readonly omittedBytes: number }
  | { readonly kind: 'structured-only'; readonly reference: ContextUnitReference }
  | { readonly kind: 'omitted-with-reason'; readonly reference: ContextUnitReference; readonly reason: 'model-generated-summary' }
export type ContextCompactionLeaf = {
  readonly reference: ContextUnitReference
  readonly sourceEventIds: readonly SessionEventId[]
  readonly sourceDigest: string
  /** A closed per-unit projection at runtime, checked against its original source on replay. */
  readonly metadata: ContextLeafMetadata
}
export type ContextCompactionAlgorithm =
  | { readonly kind: 'excerpt'; readonly name: string; readonly maxExcerptBytes: number }
  | { readonly kind: 'model-text'; readonly name: string; readonly invocationId: ModelInvocationId; readonly assemblyEventId: SessionEventId; readonly preparedEventId: SessionEventId; readonly settledEventId: SessionEventId; readonly blockIndices: readonly number[] }
export type ContextCompaction = {
  readonly coverage: readonly { readonly sessionId: SessionProjectionCoverage['sessionId']; readonly through: SessionProjectionCoverage['through'] }[]
  readonly profileEventId: SessionEventId
  readonly history: ContextHistorySelection
  readonly leaves: readonly ContextCompactionLeaf[]
  readonly protectedRefs: readonly ContextUnitReference[]
  readonly algorithm: ContextCompactionAlgorithm
  readonly rendererVersion: string
  readonly summary: string
  readonly losses: readonly ContextLoss[]
  readonly sourceDigest: string
  readonly originalRenderedBytes: number
  readonly compactedRenderedBytes: number
}
export type RuleCompactionRequest = {
  readonly profileEventId: SessionEventId
  readonly history: ContextHistorySelection
  readonly units: readonly ContextUnitReference[]
  readonly protectedRefs: readonly ContextUnitReference[]
  readonly maxExcerptBytes: number
}
/** Complete immutable input for deterministic rule-compaction preview. */
export type ContextCompactionInput = {
  readonly snapshot: SessionSnapshot
  readonly profile: CommittedSessionEvent<ContextProfile>
  readonly request: RuleCompactionRequest
}
export type ContextCompactionResult =
  | { readonly kind: 'ready'; readonly compaction: ContextCompaction }
  | { readonly kind: 'not-beneficial'; readonly originalBytes: number; readonly compactedBytes: number; readonly minSavingsBytes: number }
  | { readonly kind: 'too-large'; readonly maximum: number }
  | Extract<ContextBuildFailure, { readonly kind: 'resource-limit' }>
export type CommittedCompactionResult =
  | { readonly kind: 'committed'; readonly committed: CommittedSessionEvent<ContextCompaction> }
  | Exclude<ContextCompactionResult, { readonly kind: 'ready' }>
export type ContextAdoption =
  | { readonly kind: 'not-yet-adopted' }
  | { readonly kind: 'not-adopted-at-next-event'; readonly eventId: SessionEventId }
  | { readonly kind: 'adopted'; readonly preparedEventId: SessionEventId; readonly invocationId: ModelInvocationId }
export type ContextAssemblyRead = { readonly committed: CommittedSessionEvent<ContextAssembly>; readonly adoption: ContextAdoption }
export type ContextRebuildResult =
  | { readonly kind: 'rebuilt'; readonly request: ModelRequest; readonly assembly: ContextAssembly; readonly adoption: ContextAdoption }
  | { readonly kind: 'unsupported'; readonly version: string }

/** The full source graph is bounded before indexing; no live surface is read here. */
export type ContextAssemblyInput = {
  readonly snapshot: SessionSnapshot
  readonly profile: CommittedSessionEvent<ContextProfile>
  readonly selection: ContextSelectionSpec
  readonly captured: ContextCapturedFacts
  readonly sessionMaxRecordBytes: number
}
export type ContextContinuationIdentity = {
  readonly namespace: string; readonly version: number; readonly providerId: string; readonly model: string
}
export type ContextToolOutcomeMetadata = {
  readonly invocationId: string
  readonly requestedEventId: SessionEventId
  readonly settledEventId: SessionEventId
  readonly outcome: import('../tool/contract.js').ToolSettlement['outcome']
  readonly execution: import('../tool/contract.js').ToolSettlement['execution']
  readonly emission: import('../tool/contract.js').ToolSettlement['emission']
  readonly cleanup: import('../tool/contract.js').ToolSettlement['cleanup']
  readonly operationClass: ToolDefinition['operationClass'] | null
}
export type ContextToolIntentMetadata = {
  readonly outputBlockIndex: number; readonly callId: string; readonly name: string
  readonly argumentsStatus: 'valid-json' | 'invalid-json'
  readonly result: ContextToolOutcomeMetadata
}
export type ContextPeerMetadata = {
  readonly kind: 'peer-message' | 'outbox-message'
  readonly messageId: string; readonly sender: string; readonly recipient: string
  readonly channelId: string; readonly channelSequence: number; readonly correlationId: string
  readonly causationId: string | null; readonly replyTo: string | null
  readonly type: string; readonly payloadVersion: number; readonly createdAt: string
  readonly status: 'pending' | 'processed' | 'abandoned' | 'delivered' | 'rejected'
  readonly terminalEventId: SessionEventId | null
}
/** These fields are structural facts. Free-form body text is always kept separately. */
export type ContextLeafMetadata =
  | { readonly kind: 'user-input'; readonly origin: 'host-authored' | 'host-import'; readonly originLabel: string }
  | { readonly kind: 'assistant-response'; readonly invocationId: string; readonly preparedEventId: SessionEventId; readonly settledEventId: SessionEventId; readonly continuation: ContextContinuationIdentity | null }
  | { readonly kind: 'tool-exchange'; readonly invocationId: string; readonly preparedEventId: SessionEventId; readonly settledEventId: SessionEventId; readonly intents: readonly ContextToolIntentMetadata[]; readonly continuation: ContextContinuationIdentity | null }
  | { readonly kind: 'tool-observation'; readonly result: ContextToolOutcomeMetadata }
  | ContextPeerMetadata
  | { readonly kind: 'memory'; readonly key: string; readonly tags: readonly string[]; readonly origin: MemoryOrigin }
  | { readonly kind: 'legacy'; readonly preparedEventId: SessionEventId; readonly fromMessage: number; readonly toMessage: number; readonly omitted: readonly ('instructions' | 'continuation-text')[] }
  | { readonly kind: 'diagnostic'; readonly invocationId: string; readonly outcome: import('../model/settlement.js').ModelOutcome; readonly protocolComplete: boolean; readonly stopReason: import('../model/contract.js').ModelStopReason | null; readonly cleanup: import('../model/settlement.js').ModelSettlement['cleanup'] }
export type ContextUnitMetadata = ContextLeafMetadata
  | { readonly kind: 'compacted-history'; readonly algorithm: string; readonly leafReferences: readonly ContextUnitReference[]; readonly losses: readonly ContextLoss[]; readonly structures: readonly ContextLeafMetadata[]; readonly continuationPolicy: 'not-carried' }

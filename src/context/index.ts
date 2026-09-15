export { ContextError } from './errors.js'
export type { ContextErrorCode } from './errors.js'
export { assembleContext } from './assembler.js'
export { previewCompaction } from './compaction-preview.js'
export { retrieveSessionMemory } from './memory.js'
export type { ContextMemorySearchCandidate } from './memory.js'
export { projectContextSession, readAssembly, rebuildAssembly } from './projection.js'
export type { ContextSessionSnapshot } from './projection.js'
export { SessionContext } from './session-context.js'
export type { ContextOperationOptions, SessionContextOptions, SessionContextStatus } from './session-context.js'
export { SessionContextKey, createSessionContextComponent } from './component.js'
export type { SessionContextComponentOptions } from './component.js'
export {
  contextAssemblyCommittedEvent,
  contextCompactionCommittedEvent,
  contextInputRecordedEvent,
  contextMemoryRecordedEvent,
  contextMemoryRetractedEvent,
  contextProfileRecordedEvent,
  contextSessionEventDefinitions,
} from './session-events.js'
export type {
  CommittedCompactionResult,
  CommittedContextBuildResult,
  CompactionSourceSelection,
  ContextAdoption,
  ContextAssembly,
  ContextAssemblyInput,
  ContextAssemblyRead,
  ContextBlockedReason,
  ContextBudgetLimits,
  ContextBudgetReport,
  ContextBuildFailure,
  ContextBuildResult,
  ContextCapturedFacts,
  ContextCompaction,
  ContextCompactionAlgorithm,
  ContextCompactionInput,
  ContextCompactionLeaf,
  ContextCompactionResult,
  ContextContinuationIdentity,
  ContextCut,
  ContextDeferredInbox,
  ContextHistorySelection,
  ContextInput,
  ContextLeafMetadata,
  ContextLoss,
  ContextMemoryCandidate,
  ContextMemoryHead,
  ContextMemoryQuery,
  ContextMemoryRecord,
  ContextMemoryRetraction,
  ContextMessageSupport,
  ContextModelTarget,
  ContextOmission,
  ContextOmissionReason,
  ContextPeerMetadata,
  ContextPendingOutbox,
  ContextProfile,
  ContextProvenance,
  ContextProvenanceSource,
  ContextRebuildResult,
  ContextSelectedUnit,
  ContextSelectionSpec,
  ContextSourceReference,
  ContextTextReference,
  ContextTokenAccounting,
  ContextToolIntentMetadata,
  ContextToolOutcomeMetadata,
  ContextToolSurface,
  ContextUnitMetadata,
  ContextUnitReference,
  InboxDisposition,
  MemoryOrigin,
  PromptSection,
  RuleCompactionRequest,
} from './contract.js'

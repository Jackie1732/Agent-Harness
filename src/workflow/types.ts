import type { AgentBudget } from '../agent/contract.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { SessionAddress, SessionEventId } from '../session/ids.js'
import type { MailboxReservation } from '../communication/protocol-capacity.js'
import type { ChannelId } from '../communication/ids.js'

/** One event identity is meaningful only within its owning Session. */
export type WorkflowEventRef = {
  readonly address: SessionAddress
  readonly eventId: SessionEventId
}

export interface WorkflowMember {
  readonly memberKey: string
  readonly address: SessionAddress
  readonly roles: readonly string[]
  readonly canProduce: boolean
  readonly canReview: boolean
  readonly specFingerprint: string
  readonly contextFingerprint: string
  readonly budgetCeiling: AgentBudget
  readonly resourceIds: readonly string[]
}

export interface WorkflowCommunication {
  readonly ask: readonly { readonly from: string; readonly to: string }[]
  readonly groups: readonly { readonly from: string; readonly recipients: readonly string[] }[]
  readonly disclosures: readonly { readonly nodeKey: string; readonly recipients: readonly string[] }[]
}

export type WorkflowDependency = { readonly nodeKey: string; readonly mode: 'required' | 'optional' }
export type WorkflowInputSource =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'accepted'; readonly nodeKey: string; readonly path: readonly string[]; readonly fallback?: JsonValue }
export type WorkflowInput = { readonly name: string; readonly source: WorkflowInputSource }
export type WorkflowGuard = { readonly kind: 'always' }
  | { readonly kind: 'equals'; readonly nodeKey: string; readonly path: readonly string[]; readonly value: string | number | boolean | null }
export type WorkflowOutput = { readonly kind: 'text'; readonly name: string }
  | { readonly kind: 'json'; readonly schema: JsonObject; readonly artifacts: readonly {
    readonly name: string
    readonly source: { readonly kind: 'json-text'; readonly path: readonly string[] }
      | { readonly kind: 'write-text'; readonly path: string }
      | { readonly kind: 'write-text'; readonly paths: readonly string[] }
  }[] }
export type WorkflowAcceptance = { readonly kind: 'schema-only' }
  | { readonly kind: 'reviewed-all'; readonly reviewers: readonly string[] }
export type WorkflowWorkspace = { readonly kind: 'none' }
  | { readonly kind: 'shared-read' | 'exclusive-write'; readonly resourceId: string;
    readonly readFiles: readonly string[]; readonly writePrefixes: readonly string[] }
export interface WorkflowAttempt {
  readonly workerGrant: AgentBudget
  readonly reviewerGrants: readonly { readonly memberKey: string; readonly grant: AgentBudget }[]
  readonly durationMs: number
  readonly retryDecisionMs: number
  readonly toolNames: readonly string[]
  readonly nativeActions: readonly string[]
  readonly workspace: WorkflowWorkspace
}
export interface WorkflowNode {
  readonly nodeKey: string
  readonly executor: string
  readonly task: string
  readonly dependencies: readonly WorkflowDependency[]
  readonly inputs: readonly WorkflowInput[]
  readonly inputSchema: JsonObject
  readonly guard: WorkflowGuard
  readonly output: WorkflowOutput
  readonly acceptance: WorkflowAcceptance
  readonly attempts: readonly WorkflowAttempt[]
}
export interface WorkflowLimits {
  readonly maxNodes: number
  readonly maxEdges: number
  readonly maxMembers: number
  readonly maxAttemptsPerNode: number
  readonly maxReviewersPerNode: number
  readonly maxActiveAssignments: number
  readonly maxDefinitions: number
  readonly maxArtifactsPerAttempt: number
  readonly maxArtifactBytes: number
  readonly maxTotalArtifactBytes: number
  readonly maxDefinitionBytes: number
  readonly maxSchemaDepth: number
  readonly maxSchemaNodes: number
  readonly maxValueBytes: number
  readonly maxTextBytes: number
  readonly maxProtocolMessages: number
  readonly maxQuestions: number
  readonly maxIncomingQuestions: number
  readonly maxGroups: number
  readonly maxGroupRecipients: number
  readonly maxIncomingGroupMessages: number
  readonly maxProgress: number
  readonly maxWaitMs: number
  readonly maxCommitConflicts: number
  readonly maxDiscoveryEntries: number
  readonly maxRecoveryWrites: number
  readonly maxReportEntries: number
}
export interface WorkflowDefinition {
  readonly version: 1
  readonly workflowKey: string
  readonly coordinator: SessionAddress
  readonly roster: readonly WorkflowMember[]
  readonly communication: WorkflowCommunication
  readonly nodes: readonly WorkflowNode[]
  readonly requiredOutputs: readonly string[]
  readonly deadline: string
  readonly budget: AgentBudget
  readonly limits: WorkflowLimits
  readonly failurePolicy: 'fail-fast'
}

export type WorkflowNodeResolution = { readonly nodeKey: string; readonly outcome: 'skipped' | 'failed'; readonly reason: string }
export type WorkflowDecision = { readonly nodeKey: string; readonly assignment: WorkflowEventRef;
  readonly outcome: 'accepted' | 'rejected'; readonly expectedRevision: 0;
  readonly value: JsonValue | null; readonly artifacts: readonly WorkflowEventRef[] }

/** Complete production reservation fixed at the coordinator's CP-W. */
interface WorkflowAssignmentFields {
  readonly definition: SessionEventId
  readonly nodeKey: string
  readonly attempt: number
  readonly memberKey: string
  readonly memberAddress: SessionAddress
  readonly channelId: ChannelId
  readonly inputs: JsonObject
  readonly sourceAccepted: readonly WorkflowEventRef[]
  readonly effectiveAllowance: AgentBudget
  readonly reviewerReservations: readonly { readonly memberKey: string; readonly grant: AgentBudget }[]
  readonly toolNames: readonly string[]
  readonly nativeActions: readonly string[]
  readonly workspace: WorkflowWorkspace
  readonly workspaceBaseline: import('../subagent/workspace.js').WorkspaceBaseline | null
  readonly protocolLimits: { readonly maxMessageBytes: number; readonly maxRecordBytes: number }
  readonly protocolReserve: { readonly coordinator: MailboxReservation; readonly member: MailboxReservation }
  readonly deadline: string
  readonly acceptance: WorkflowAcceptance
}
export type WorkflowAssignment = WorkflowAssignmentFields & ({ readonly kind: 'production' }
  | { readonly kind: 'review'; readonly reviewOf: { readonly assignment: WorkflowEventRef; readonly proposal: WorkflowEventRef } })

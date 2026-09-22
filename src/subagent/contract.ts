import type { AgentBudget } from '../agent/contract.js'
import type { SessionEventId } from '../session/ids.js'

/** A delegation requests a finite set of files; absolute paths remain Host-owned. */
export type DelegationWorkspace =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'shared-read' | 'exclusive-write'
    readonly resourceId: string
    readonly readFiles: readonly string[]
    readonly writePrefixes: readonly string[]
  }

/** Original caller input, retained in full for idempotency after acknowledgement loss. */
export type DelegationRequest = {
  readonly templateKey: string
  readonly templateVersion: number
  readonly task: string
  readonly materials: readonly { readonly label: string; readonly text: string }[]
  readonly requestedBudget: AgentBudget
  readonly workspace: DelegationWorkspace
}

/** Configuration ceilings; zero capacity explicitly disables the corresponding admission. */
export type SubagentLimits = {
  readonly maxUnresolvedDelegations: number
  readonly maxActiveChildren: number
  readonly maxChildDurationMs: number
  readonly maxProtocolStepsPerBatch: number
  readonly maxRecoveryWrites: number
  readonly maxRequestBytes: number
  readonly maxMaterialBytes: number
  readonly maxResultBytes: number
  readonly maxFileEntries: number
  readonly maxProtocolConflicts: number
  readonly maxDiscoveryEntries: number
}

/** A finite, explicit authority; possession of a parent tool does not imply delegation rights. */
export type DelegationCapabilities = {
  readonly models: readonly { readonly providerId: string; readonly model: string }[]
  readonly tools: readonly string[]
  readonly workspaces: readonly {
    readonly resourceId: string
    readonly modes: readonly ('shared-read' | 'exclusive-write')[]
    readonly readPrefixes: readonly string[]
    readonly writePrefixes: readonly string[]
  }[]
}

/** Template requirements are all-or-nothing; permission narrowing cannot substitute a model. */
export type DelegationRequirements = {
  readonly providerId: string
  readonly model: string
  readonly tools: readonly string[]
}

export type DelegationMailboxReserve = {
  readonly parent: { readonly inbox: number; readonly outbox: number }
  readonly child: { readonly inbox: number; readonly outbox: number }
}

/** CP-D debits the grant and the parent's protocol messages in one candidate prefix. */
export type DelegationBudgetReservation = {
  readonly grant: AgentBudget
  readonly parentProtocolReserve: AgentBudget
  readonly childProtocolReserve: AgentBudget
  readonly parentReserved: AgentBudget
  readonly mailboxReserve: DelegationMailboxReserve
}

/** Persisted authority describes allowable work, not a live permission token. */
export type AgentSubagentRole =
  | { readonly role: 'none' }
  | {
    readonly role: 'parent'
    readonly templates: readonly { readonly templateKey: string; readonly templateVersion: number }[]
    readonly capabilities: DelegationCapabilities
    readonly maxDelegations: number
    readonly maxGrant: AgentBudget
  }
  | {
    readonly role: 'child'
    readonly bound: SessionEventId
    readonly deadline: string
    readonly protocolReserve: AgentBudget
    readonly maxQuestions: number
    readonly maxProgress: number
    readonly maxFileEntries: number
  }

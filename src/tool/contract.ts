import type { Awaitable } from '../effect/types.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { SessionAddress, SessionEventId, SessionId } from '../session/ids.js'
import type { ToolInvocationId } from './ids.js'

/** Declarative data, never a callback or an authorization. Names are case-sensitive. */
export interface ToolDefinition extends JsonObject {
  readonly name: string
  readonly version: number
  readonly description: string
  readonly inputSchema: JsonObject
  readonly outputSchema: JsonObject
  readonly operationClass: 'pure' | 'read-only' | 'external'
}

/** Explicit limits on definition registration and standard-schema compilation. */
export interface ToolSchemaLimits extends JsonObject {
  readonly maxSchemaBytes: number
  readonly maxSchemaDepth: number
  readonly maxSchemaNodes: number
}

/** All ceilings are explicit. Zero is allowed only for maxJournalConflicts. */
export interface ToolInvocationLimits extends ToolSchemaLimits {
  readonly maxRequestBytes: number
  readonly maxPlanBytes: number
  readonly maxArgumentsBytes: number
  readonly maxJsonDepth: number
  readonly maxJsonNodes: number
  readonly maxResultBytes: number
  readonly maxJournalConflicts: number
}

/** Safe configuration identity. No absolute root, credentials, callback, or live instance ID. */
export interface ToolProviderDescriptor extends JsonObject {
  readonly providerId: string
  readonly adapterVersion: string
  readonly resourceId: string
  readonly tools: readonly { readonly name: string; readonly version: number }[]
  readonly maxConcurrentExecutions: number
  readonly maxArgumentsBytes: number
  readonly maxResultBytes: number
}

/** Targets actually used by the scripted ledger and native workspace reader. */
export type ToolTarget =
  | { readonly kind: 'logical'; readonly resourceId: string }
  | { readonly kind: 'workspace-file'; readonly rootId: string; readonly path: string; readonly maxBytes: number }

/** Audited plan. Its historical serialization is not a reusable execution capability. */
export interface PreparedToolPlan extends JsonObject {
  readonly version: 1
  readonly encoding: 'sorted-json-utf8/v1'
  readonly definition: ToolDefinition
  readonly provider: ToolProviderDescriptor
  readonly input: JsonValue
  readonly limits: ToolInvocationLimits
  readonly target: ToolTarget
  readonly fingerprint: string
}

/** Runtime-only one-shot binding to the provider that performed prepare. */
export interface PreparedToolCall {
  readonly plan: PreparedToolPlan
  /** Acquires managed objects/capacity, not protected input or external effects. */
  acquire(committed: PreparedToolPlan, signal: AbortSignal): Awaitable<ToolExecution>
}

/** Explicit provider business result. Arbitrary Error objects never cross this boundary. */
export type ToolExecutionResult =
  | { readonly kind: 'success'; readonly value: JsonValue; readonly receipt?: string }
  | { readonly kind: 'error'; readonly code: string; readonly receipt?: string }

/** One operation. close waits for all started work and returns one shared task. */
export interface ToolExecution {
  start(): Awaitable<ToolExecutionResult>
  close(): Promise<void>
}

/** Trusted in-process implementation, not an OS sandbox or permission issuer. */
export interface ToolProvider {
  readonly descriptor: ToolProviderDescriptor
  /** Pure synchronous compilation. It must not open files or perform protected work. */
  prepare(definition: ToolDefinition, input: JsonValue, limits: ToolInvocationLimits): PreparedToolCall
  /** Stops new acquisitions, requests cancellation, and waits for borrowers to close. */
  dispose(): Promise<void>
}

/** Only the reference is caller-provided; all other provenance is read from Session facts. */
export type ToolSource =
  | { readonly kind: 'direct' }
  | {
    readonly kind: 'model'
    readonly intent: { readonly invocationId: string; readonly outputBlockIndex: number }
    readonly preparedEventId: SessionEventId
    readonly settledEventId: SessionEventId
    readonly callId: string
  }

export type ToolArguments =
  | { readonly kind: 'json'; readonly value: JsonValue }
  | { readonly kind: 'text'; readonly text: string }

export type ToolSelection =
  | { readonly kind: 'missing' }
  | { readonly kind: 'resolved'; readonly definition: ToolDefinition; readonly provider: ToolProviderDescriptor }

/** CP0: bounded request and actual execution-time selection, including missing selections. */
export interface ToolRequestedPayload extends JsonObject {
  readonly invocationId: ToolInvocationId
  readonly source: ToolSource
  readonly name: string
  readonly arguments: ToolArguments
  readonly selection: ToolSelection
  readonly limits: ToolInvocationLimits
}

export interface ToolPolicyIdentity extends JsonObject {
  readonly policyId: string
  readonly version: number
}

export interface ToolPolicyInput extends JsonObject {
  readonly sessionId: SessionId
  readonly address: SessionAddress
  readonly invocationId: ToolInvocationId
  readonly source: ToolSource
  readonly plan: PreparedToolPlan
}

export type ToolPolicyDecision = { readonly kind: 'allow' | 'deny'; readonly reasonCode: string }

/** Current-instance authorization only. Stopping its lifecycle invalidates late decisions. */
export interface ToolPolicy {
  readonly policyId: string
  readonly version: number
  readonly signal: AbortSignal
  decide(input: ToolPolicyInput, options: { readonly signal: AbortSignal }): Awaitable<ToolPolicyDecision>
}

/** CP-A: the decision actually adopted for this invocation and this complete plan. */
export interface ToolAuthorizationPayload extends JsonObject {
  readonly invocationId: ToolInvocationId
  readonly requestedEventId: SessionEventId
  readonly policy: ToolPolicyIdentity
  readonly decision: ToolPolicyDecision
  readonly plan: PreparedToolPlan
}

/** CP1: a durable dispatch intent, never a remote receipt. */
export interface ToolStartedPayload extends JsonObject {
  readonly invocationId: ToolInvocationId
  readonly authorizationEventId: SessionEventId
}

export type ToolOutcome = 'succeeded' | 'rejected' | 'failed' | 'cancelled' | 'incomplete' | 'interrupted'
export type ToolExecutionEvidence = 'not-started' | 'may-have-executed' | 'execution-observed'
export type ToolPhase = 'selection' | 'validation' | 'preparing' | 'authorizing' | 'acquiring' | 'starting' | 'executing' | 'closing' | 'committing' | 'settled'

export type ToolResult =
  | { readonly kind: 'success'; readonly value: JsonValue }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'none' }

export interface ToolCleanup extends JsonObject {
  readonly status: 'complete' | 'incomplete' | 'unknown-after-process-loss'
  readonly attempted: number | null
  readonly failed: number | null
}

/** CP2: execution evidence, bounded canonical output, and real resource settlement. */
export interface ToolSettlement extends JsonObject {
  readonly invocationId: ToolInvocationId
  readonly outcome: ToolOutcome
  readonly execution: ToolExecutionEvidence
  readonly emission: 'none' | 'may-have-occurred' | 'observed'
  readonly result: ToolResult
  readonly cleanup: ToolCleanup
  /** At most one fixed-code diagnostic; no raw exception/message/payload is retained. */
  readonly failure?: { readonly code: string; readonly phase: ToolPhase }
  readonly receipt?: string
}

/** Programmatic calls always receive a new identity from the runner, never from the caller. */
export interface DirectToolRequest {
  readonly name: string
  readonly input: JsonValue
}

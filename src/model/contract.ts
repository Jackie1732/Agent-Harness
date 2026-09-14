import type { Awaitable } from '../effect/types.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { ModelInvocationId } from './ids.js'

/** A stable output address, not an execution permission or a ToolInvocationId. */
export interface ModelIntentReference extends JsonObject {
  readonly invocationId: ModelInvocationId
  readonly outputBlockIndex: number
}

/** Opaque only to the core: each declared namespace has a closed provider decoder. */
export interface ModelContinuation extends JsonObject {
  readonly namespace: string
  readonly version: number
  readonly providerId: string
  readonly model: string
  readonly text: string
}

export interface ModelTextBlock extends JsonObject {
  readonly kind: 'text'
  readonly text: string
}

export interface ModelHistoryToolCall extends JsonObject {
  readonly kind: 'tool-call'
  readonly callId: string
  readonly name: string
  readonly argumentsText: string
  readonly source: ModelIntentReference
}

export interface ModelToolResultBlock extends JsonObject {
  readonly kind: 'tool-result'
  readonly callId: string
  readonly source: ModelIntentReference
  readonly result: JsonValue
  readonly isError: boolean
}

export type ModelInputMessage =
  | { readonly role: 'user'; readonly content: readonly (ModelTextBlock | ModelToolResultBlock)[] }
  | { readonly role: 'assistant'; readonly content: readonly (ModelTextBlock | ModelHistoryToolCall)[]; readonly continuation?: ModelContinuation }

/** Declarative only; no function, registry, remote reference, or execution authority. */
export interface ModelToolDefinition extends JsonObject {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
}

/** Closed, versioned provider controls. Never spread these fields into an HTTP body. */
export interface ModelRequestProfile extends JsonObject {
  readonly namespace: string
  readonly version: number
  readonly options: JsonObject
}

export interface ModelRequest extends JsonObject {
  readonly model: string
  readonly instructions: readonly string[]
  readonly messages: readonly ModelInputMessage[]
  readonly tools: readonly ModelToolDefinition[]
  readonly maxOutputTokens: number
  readonly temperature?: number
  readonly topP?: number
  readonly profile?: ModelRequestProfile
}

/** Resource ceilings on a single transport, including pings and empty SSE records. */
export interface ModelStreamLimits extends JsonObject {
  readonly maxFrameBytes: number
  readonly maxStreamBytes: number
  readonly maxFrames: number
}

/** Local policy, explicitly supplied and recorded with the prepared invocation. */
export interface ModelRunnerLimits extends JsonObject {
  readonly maxInputBytes: number
  readonly maxNormalizedResultBytes: number
  readonly maxOutputBlocks: number
  /** Zero explicitly forbids generated tool intents. */
  readonly maxToolCalls: number
  /** Number of local CAS retries after the initial journal attempt; zero disables retries. */
  readonly maxJournalConflicts: number
}

export interface ModelSupport extends JsonObject {
  readonly text: boolean
  readonly instructions: boolean
  readonly tools: boolean
  readonly controls: readonly ('temperature' | 'topP')[]
  readonly profiles: readonly string[]
  readonly continuations: readonly string[]
}

/** Safe configuration identity, not the runtime identity of a Capability activation. */
export interface ModelProviderDescriptor extends JsonObject {
  readonly providerId: string
  readonly protocol: string
  readonly adapterVersion: string
  readonly endpoint: string
  readonly semanticHeaders: JsonObject
  readonly support: ModelSupport
  readonly streamLimits: ModelStreamLimits
  readonly maxConcurrentExchanges: number
}

/** Complete reproducible submission, excluding authentication and runtime objects. */
export interface PreparedSubmission extends JsonObject {
  readonly version: 1
  readonly encoding: 'sorted-json-utf8/v1'
  readonly request: ModelRequest
  readonly binding: ModelProviderDescriptor
  readonly wireBody: JsonObject
  readonly fingerprint: string
}

/** A one-shot runtime binding paired with its durable description. */
export interface PreparedModelCall {
  readonly submission: PreparedSubmission
  /** Local acquisition only. Generation is forbidden until the returned exchange starts. */
  acquire(committed: PreparedSubmission, signal: AbortSignal): Awaitable<ModelExchange>
}

/** Provider-facing frame vocabulary; it is not a public token subscription API. */
export type ModelFrame =
  | { readonly kind: 'message-start'; readonly reportedModel: string; readonly responseId: string; readonly requestId?: string }
  | { readonly kind: 'block-start'; readonly index: number; readonly block: 'text' }
  | { readonly kind: 'block-start'; readonly index: number; readonly block: 'tool-call'; readonly callId: string; readonly name: string }
  | { readonly kind: 'block-start'; readonly index: number; readonly block: 'continuation'; readonly namespace: string; readonly version: number; readonly providerId: string; readonly model: string }
  | { readonly kind: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly kind: 'arguments-delta'; readonly index: number; readonly text: string }
  | { readonly kind: 'continuation-delta'; readonly index: number; readonly text: string }
  | { readonly kind: 'block-end'; readonly index: number }
  | { readonly kind: 'usage'; readonly counts: ModelUsageCounts }
  | { readonly kind: 'generation-stop'; readonly stopReason: ModelStopReason }
  | { readonly kind: 'complete'; readonly stopReason: ModelStopReason }

/** Cumulative provider counters. Missing is unknown, not zero. */
export interface ModelUsageCounts extends JsonObject {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheCreationInputTokens?: number
  readonly reasoningOutputTokens?: number
}

export interface ModelUsage extends ModelUsageCounts {
  readonly source: 'provider'
  readonly completeness: 'unknown' | 'partial' | 'complete'
}

export type ModelStopReason = 'stop' | 'tool-calls' | 'length' | 'refusal' | 'content-filter'

export type ModelOutputBlock =
  | { readonly kind: 'text'; readonly index: number; readonly text: string; readonly complete: boolean }
  | { readonly kind: 'tool-call'; readonly index: number; readonly callId: string; readonly name: string; readonly argumentsText: string; readonly argumentsStatus: 'partial' | 'valid-json' | 'invalid-json'; readonly advertisement: 'advertised' | 'not-advertised'; readonly complete: boolean }
  | { readonly kind: 'continuation'; readonly index: number; readonly capsule: ModelContinuation; readonly complete: boolean }

/** Only one canonical result copy is retained; transport frames are not archived. */
export interface NormalizedModelResult extends JsonObject {
  readonly blocks: readonly ModelOutputBlock[]
  readonly usage: ModelUsage
  readonly protocolComplete: boolean
  readonly stopReason: ModelStopReason | null
  readonly reportedModel?: string
  readonly responseId?: string
  readonly requestId?: string
}

/** Request-scoped resources. close must settle all started I/O, even after failure. */
export interface ModelExchange {
  /** At most once. Calling this method is the external emission boundary. */
  start(): Awaitable<AsyncIterable<ModelFrame>>
  /** Idempotent shared release; failure must not silently re-run a partial cleanup. */
  close(): Promise<void>
}

/** Stable capability contract implemented by trusted in-process provider code. */
export interface ModelProvider {
  readonly descriptor: ModelProviderDescriptor
  /** Synchronous, pure request validation/compilation and runtime binding capture. */
  prepare(request: ModelRequest): PreparedModelCall
  /** Stop admission and wait for outstanding exchanges to relinquish the client. */
  dispose(): Promise<void>
}

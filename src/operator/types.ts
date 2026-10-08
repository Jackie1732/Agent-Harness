import type { JsonObject } from '../foundation/json.js'
import type { ApiAcceptance, ControlMethod, Params } from '../protocol/index.js'
import type { SessionProjectionCoverage } from '../session/types.js'
import type { AgentActionReference } from '../agent/contract.js'
import type { HostShutdownMode } from '../host/runtime.js'
import type { ResolvedOperatorProfile } from './profile.js'
export type OperatorAcceptance = ApiAcceptance | 'accepted'

export interface OperatorScope extends JsonObject {
  readonly connection: 'local' | 'remote' | null
  readonly connectionLifetime: 'command' | 'session' | null
  readonly hostKey: string | null
  readonly instanceId: string | null
  readonly sessionId: string | null
}

/** One request's observation and effect; shutdown failure never rewrites acceptance. */
export interface OperatorResult {
  readonly operatorVersion: 1
  readonly kind: 'operator-result'
  readonly command: string
  readonly profileKey: string | null
  readonly operationId: string | null
  readonly status: 'ok' | 'pending' | 'rejected' | 'unknown' | 'failed'
  readonly acceptance: OperatorAcceptance
  readonly scope: OperatorScope
  readonly receivedAt: string | null
  readonly cuts: readonly SessionProjectionCoverage[] | null
  readonly result: unknown
  readonly error: { readonly code: string; readonly domainCode: string | null; readonly message: string } | null
  readonly closing: { readonly status: 'not-owned' | 'released' | 'failed' | 'pending'; readonly mode: HostShutdownMode | null }
}
export interface OperatorCallOptions {
  readonly signal?: AbortSignal
  readonly acknowledgeIntent?: string
  readonly parentIntent?: string
}
export interface OperatorSubmit {
  readonly agentKey: string; readonly text: string; readonly submissionKey?: string
  readonly wait?: AgentActionReference; readonly drive?: boolean; readonly acknowledgeIntent?: string
  readonly signal?: AbortSignal
}
export interface OperatorIntent {
  readonly id: string; readonly method: ControlMethod; readonly params: JsonObject
  readonly scope: OperatorScope; readonly preparedAt: string; readonly parentIntent: string | null
  readonly callerNamespace: string | null; readonly certificateFingerprint: string | null
  readonly configDigest: string; readonly acknowledgedIntent: string | null
  readonly acknowledgementReason: 'operator-requested-new-batch' | null
  readonly outcome: { readonly acceptance: OperatorAcceptance; readonly resultDigest: string | null; readonly summary: JsonObject;
    readonly receivedAt: string; readonly errorCode: string | null } | null
}
/** Own one connection and its journal. Reads never schedule a Host batch. */
export interface OperatorSession {
  readonly profile: ResolvedOperatorProfile
  execute<M extends ControlMethod>(method: M, params: Params<M>, options?: OperatorCallOptions): Promise<OperatorResult>
  submit(input: OperatorSubmit): Promise<OperatorResult>
  resume(id: string, options?: { readonly signal?: AbortSignal }): Promise<OperatorResult>
  intents(): readonly OperatorIntent[]
  checkpoint(sessionId: string, sequence: number): Promise<void>
  eventCheckpoint(sessionId: string): number | undefined
  close(mode?: HostShutdownMode): Promise<void>
}

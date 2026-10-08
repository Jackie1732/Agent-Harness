import type { ControlMethod, Params, Result } from '../protocol/index.js'

/** Authenticated caller grants and the stable namespace used by durable keyed operations. */
export interface ControlCaller {
  readonly namespace: string
  readonly methods: readonly ControlMethod[]
  readonly agentKeys: readonly string[]
  readonly workflowKeys: readonly string[]
}

/** Domain operations use the existing method parameters without a transport envelope. */
export type ControlRequest<M extends ControlMethod> = { readonly method: M; readonly params: Params<M> }
export type AnyControlOperation = { [M in ControlMethod]: ControlRequest<M> }[ControlMethod]

/** Concurrent category quotas remain occupied until their domain operation settles. */
export interface ControlAdmissionLimits {
  readonly maxPendingInputs: number
  readonly maxPendingControls: number
  readonly maxObservers: number
  readonly maxPendingShutdowns: number
}

/** Consumers supply their actual event-page byte allowance independently of HTTP encoding. */
export interface ControlLimits {
  readonly maxWaitMs: number
  readonly observerScanIntervalMs: number
  readonly maxPageEvents: number
  readonly pageBytes: number
}

/** Host shutdown reports domain release; each consumer owns its service and connection facts. */
export type ApplicationResult<M extends ControlMethod> = M extends 'host.shutdown' ? Omit<Result<M>, 'serviceStatus'> : Result<M>

/** A mutation can return before a subsequent observation or transport response fails. */
export interface ControlProgress { domainReturned: boolean }

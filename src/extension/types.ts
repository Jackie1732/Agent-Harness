import type { Awaitable } from '../effect/index.js'
import type { Brand } from '../foundation/brand.js'

declare const eventPayload: unique symbol
declare const middlewareTypes: unique symbol

/** Lifecycle state of one extension scope. */
export type ScopeStatus = 'staging' | 'accepting' | 'disposing' | 'disposed'

/** Lifecycle state of one listener or middleware registration. */
export type RegistrationStatus = 'registered' | 'disposed'

/** Registry-local identity of one scope. */
export type ScopeId = Brand<string, 'ScopeId'>

/** Scope-tree-local identity of one registration. */
export type RegistrationId = Brand<string, 'RegistrationId'>

/** Typed identity of one in-process event. */
export interface EventName<TPayload> {
  /** Diagnostic name; object identity selects the event. */
  readonly name: string
  /** Required compile-time marker that prevents structural construction. */
  readonly [eventPayload]: { readonly value: TPayload }
}

/** Typed identity of one middleware call. */
export interface MiddlewareName<TRequest, TResult> {
  /** Diagnostic name; object identity selects the middleware chain. */
  readonly name: string
  /** Required compile-time markers that prevent structural construction. */
  readonly [middlewareTypes]: {
    readonly request: TRequest
    readonly result: TResult
  }
}

/** Continue one middleware chain at most once. */
export interface MiddlewareNext<TRequest, TResult> {
  /** Continue with the request received by the current handler. */
  (): Promise<TResult>
  /** Continue with a replacement request. */
  (request: TRequest): Promise<TResult>
}

/** Listener for one typed in-process event. */
export type EventListener<TPayload> = (payload: TPayload) => Awaitable<void>

/** Handler in one typed middleware chain. */
export type MiddlewareHandler<TRequest, TResult> = (
  request: TRequest,
  next: MiddlewareNext<TRequest, TResult>,
) => Awaitable<TResult>

/** Releasable handle for one listener or middleware registration. */
export interface RegistrationHandle {
  /** Stable identity within the owning Scope Tree. */
  readonly id: RegistrationId
  /** Scope that owns this registration. */
  readonly scopeId: ScopeId
  /** Diagnostic label supplied at registration. */
  readonly label: string
  /** Whether the registration can still become a dispatch candidate. */
  readonly status: RegistrationStatus

  /**
   * Remove this registration without waiting for an already running callback.
   *
   * @returns The shared settlement promise for this registration release.
   */
  dispose(): Promise<void>
}

/** JSON-safe projection of one registration owned by a scope. */
export interface ScopeRegistrationSnapshot {
  readonly id: string
  readonly kind: 'listener' | 'middleware'
  readonly name: string
  readonly label: string
  readonly ordinal: number
}

/** JSON-safe projection of one node in a Scope subtree. */
export interface ScopeNodeSnapshot {
  readonly id: string
  readonly label: string
  readonly status: ScopeStatus
  readonly parent?: string
  readonly children: readonly string[]
  readonly registrations: readonly ScopeRegistrationSnapshot[]
  readonly ownInFlight: number
}

/** JSON-safe point-in-time projection of one Scope subtree. */
export interface ScopeSnapshot {
  /** Scope Tree revision at the synchronous snapshot point. */
  readonly revision: number
  readonly scopeId: string
  readonly status: ScopeStatus
  readonly subtreeInFlight: number
  readonly scopes: readonly ScopeNodeSnapshot[]
}

/** One listener failure retained by an aggregate event error. */
export interface EventListenerFailure {
  readonly registrationId: RegistrationId
  readonly scopeId: ScopeId
  readonly listenerLabel: string
  readonly reason: unknown
}

/** Runtime-owned extension scope. */
export interface Scope {
  readonly id: ScopeId
  readonly label: string
  readonly status: ScopeStatus
  readonly signal: AbortSignal

  /**
   * Register a listener owned by this scope.
   *
   * @param event - Typed event identity.
   * @param label - Non-empty diagnostic label; labels may repeat.
   * @param listener - Callback invoked for this event.
   * @returns A handle that removes only this registration.
   */
  on<TPayload>(
    event: EventName<TPayload>,
    label: string,
    listener: EventListener<TPayload>,
  ): RegistrationHandle

  /**
   * Register a handler owned by this scope.
   *
   * @param name - Typed middleware identity.
   * @param label - Non-empty diagnostic label; labels may repeat.
   * @param handler - Handler that may short-circuit or delegate once.
   * @returns A handle that removes only this registration.
   */
  intercept<TRequest, TResult>(
    name: MiddlewareName<TRequest, TResult>,
    label: string,
    handler: MiddlewareHandler<TRequest, TResult>,
  ): RegistrationHandle

  /**
   * Notify every eligible listener serially and aggregate their failures.
   *
   * @param event - Typed event identity.
   * @param payload - Payload delivered by reference.
   * @returns A promise that settles after all eligible listeners were attempted.
   */
  emit<TPayload>(event: EventName<TPayload>, payload: TPayload): Promise<void>

  /**
   * Run one lazy middleware chain.
   *
   * @param name - Typed middleware identity.
   * @param request - Initial request.
   * @param terminal - Optional final operation after every handler delegates.
   * @returns The outer handler or terminal result.
   */
  invoke<TRequest, TResult>(
    name: MiddlewareName<TRequest, TResult>,
    request: TRequest,
    terminal?: (request: TRequest) => Awaitable<TResult>,
  ): Promise<TResult>

  /**
   * Create a child scope whose lifetime cannot exceed this scope.
   *
   * @param label - Non-empty diagnostic label; labels may repeat.
   * @returns The new child scope.
   */
  derive(label: string): Scope

  /**
   * Wait for the first later point at which this subtree has no managed work.
   *
   * @returns An independently materialized snapshot at that quiescent point.
   */
  whenQuiescent(): Promise<ScopeSnapshot>

  /** Return a JSON-safe projection without waiting for quiescence. */
  snapshot(): ScopeSnapshot

  /**
   * Stop this subtree synchronously, then wait for all accepted work to settle.
   *
   * @returns The shared settlement promise outside a re-entrant task chain.
   */
  dispose(): Promise<void>
}

/** Registry-owned root facade; only the registry may end its lifetime. */
export type RootScope = Omit<Scope, 'dispose'>

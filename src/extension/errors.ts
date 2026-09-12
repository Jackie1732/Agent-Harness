import { HarnessError } from '../foundation/error.js'
import type { JsonObject } from '../foundation/json.js'
import type { EventListenerFailure, ScopeStatus } from './types.js'

/** Stable error codes reported by the extension layer. */
export type ExtensionErrorCode =
  | 'SCOPE_INACTIVE'
  | 'SCOPE_NOT_PUBLISHED'
  | 'EVENT_NAME_CONFLICT'
  | 'MIDDLEWARE_NAME_CONFLICT'
  | 'EVENT_LISTENERS_FAILED'
  | 'MIDDLEWARE_NEXT_REPEATED'
  | 'MIDDLEWARE_NEXT_INACTIVE'
  | 'MIDDLEWARE_UNTERMINATED'
  | 'SCOPE_REENTRANT_WAIT'

/** An operation requires a scope that still accepts work. */
export class ScopeInactiveError extends HarnessError<'SCOPE_INACTIVE'> {
  /** Identity of the scope that rejected the operation. */
  readonly scopeId: string
  /** Diagnostic label of the scope. */
  readonly scopeLabel: string
  /** Lifecycle state observed by the operation. */
  readonly status: ScopeStatus
  /** Operation rejected by the scope. */
  readonly operation: string

  /**
   * Create an error for an operation on a closing or closed scope.
   *
   * @param scopeId - Identity of the scope.
   * @param scopeLabel - Diagnostic label of the scope.
   * @param status - Lifecycle state observed by the operation.
   * @param operation - Operation rejected by the scope.
   */
  constructor(scopeId: string, scopeLabel: string, status: ScopeStatus, operation: string) {
    super(
      'SCOPE_INACTIVE',
      `scope "${scopeLabel}" is ${status} and cannot accept ${operation}`,
      { details: { scopeId, scopeLabel, status, operation } },
    )
    this.name = 'ScopeInactiveError'
    this.scopeId = scopeId
    this.scopeLabel = scopeLabel
    this.status = status
    this.operation = operation
  }
}

/** A staging scope tried to trigger behavior before its component committed. */
export class ScopeNotPublishedError extends HarnessError<'SCOPE_NOT_PUBLISHED'> {
  /** Identity of the staging scope. */
  readonly scopeId: string
  /** Diagnostic label of the staging scope. */
  readonly scopeLabel: string
  /** Invocation attempted before publication. */
  readonly operation: string

  /**
   * Create an error for an invocation through a staging scope.
   *
   * @param scopeId - Identity of the staging scope.
   * @param scopeLabel - Diagnostic label of the staging scope.
   * @param operation - Invocation attempted before publication.
   */
  constructor(scopeId: string, scopeLabel: string, operation: string) {
    super(
      'SCOPE_NOT_PUBLISHED',
      `scope "${scopeLabel}" cannot ${operation} before its activation commits`,
      { details: { scopeId, scopeLabel, operation } },
    )
    this.name = 'ScopeNotPublishedError'
    this.scopeId = scopeId
    this.scopeLabel = scopeLabel
    this.operation = operation
  }
}

/** Two different event identities share one diagnostic name in a Scope Tree. */
export class EventNameConflictError extends HarnessError<'EVENT_NAME_CONFLICT'> {
  /** Diagnostic name shared by different event identities. */
  readonly eventName: string
  /** Scope that owns the existing identity. */
  readonly existingScopeId: string
  /** Scope that supplied the conflicting identity. */
  readonly incomingScopeId: string
  /** Operation that observed the conflict. */
  readonly operation: string

  /**
   * Create an error for conflicting event identities.
   *
   * @param eventName - Diagnostic name shared by both identities.
   * @param existingScopeId - Scope that owns the existing identity.
   * @param incomingScopeId - Scope that supplied the conflicting identity.
   * @param operation - Operation that observed the conflict.
   */
  constructor(
    eventName: string,
    existingScopeId: string,
    incomingScopeId: string,
    operation: string,
  ) {
    super(
      'EVENT_NAME_CONFLICT',
      `event name "${eventName}" is already used by another identity`,
      { details: { eventName, existingScopeId, incomingScopeId, operation } },
    )
    this.name = 'EventNameConflictError'
    this.eventName = eventName
    this.existingScopeId = existingScopeId
    this.incomingScopeId = incomingScopeId
    this.operation = operation
  }
}

/** Two different middleware identities share one diagnostic name in a Scope Tree. */
export class MiddlewareNameConflictError extends HarnessError<'MIDDLEWARE_NAME_CONFLICT'> {
  /** Diagnostic name shared by different middleware identities. */
  readonly middlewareName: string
  /** Scope that owns the existing identity. */
  readonly existingScopeId: string
  /** Scope that supplied the conflicting identity. */
  readonly incomingScopeId: string
  /** Operation that observed the conflict. */
  readonly operation: string

  /**
   * Create an error for conflicting middleware identities.
   *
   * @param middlewareName - Diagnostic name shared by both identities.
   * @param existingScopeId - Scope that owns the existing identity.
   * @param incomingScopeId - Scope that supplied the conflicting identity.
   * @param operation - Operation that observed the conflict.
   */
  constructor(
    middlewareName: string,
    existingScopeId: string,
    incomingScopeId: string,
    operation: string,
  ) {
    super(
      'MIDDLEWARE_NAME_CONFLICT',
      `middleware name "${middlewareName}" is already used by another identity`,
      { details: { middlewareName, existingScopeId, incomingScopeId, operation } },
    )
    this.name = 'MiddlewareNameConflictError'
    this.middlewareName = middlewareName
    this.existingScopeId = existingScopeId
    this.incomingScopeId = incomingScopeId
    this.operation = operation
  }
}

/** One event completed after one or more listeners failed. */
export class EventListenersFailedError extends HarnessError<'EVENT_LISTENERS_FAILED'> {
  /** Diagnostic name of the event. */
  readonly eventName: string
  /** Original listener failures in invocation order. */
  readonly failures: readonly EventListenerFailure[]

  /**
   * Create the aggregate error after every eligible listener was attempted.
   *
   * @param eventName - Diagnostic name of the event.
   * @param attempted - Number of listeners that started.
   * @param failures - Original listener failures in invocation order.
   */
  constructor(eventName: string, attempted: number, failures: readonly EventListenerFailure[]) {
    super(
      'EVENT_LISTENERS_FAILED',
      `${failures.length} of ${attempted} listener(s) failed for event "${eventName}"`,
      {
        details: {
          eventName,
          attempted,
          failed: failures.length,
          registrationIds: failures.map(failure => String(failure.registrationId)),
          scopeIds: failures.map(failure => String(failure.scopeId)),
        },
      },
    )
    this.name = 'EventListenersFailedError'
    this.eventName = eventName
    this.failures = [...failures]
  }
}

interface MiddlewareRegistrationDetails {
  readonly middlewareName: string
  readonly registrationId: string
  readonly scopeId: string
  readonly handlerLabel: string
}

function middlewareDetails(
  middlewareName: string,
  registrationId: string,
  scopeId: string,
  handlerLabel: string,
): MiddlewareRegistrationDetails & JsonObject {
  return { middlewareName, registrationId, scopeId, handlerLabel }
}

/** Shared diagnostic state of one middleware registration misuse. */
abstract class MiddlewareRegistrationError<Code extends string> extends HarnessError<Code> {
  /** Diagnostic name of the middleware chain. */
  readonly middlewareName: string
  /** Identity of the handler registration. */
  readonly registrationId: string
  /** Identity of the scope that owns the handler. */
  readonly scopeId: string
  /** Diagnostic label of the handler. */
  readonly handlerLabel: string

  protected constructor(
    code: Code,
    message: string,
    middlewareName: string,
    registrationId: string,
    scopeId: string,
    handlerLabel: string,
  ) {
    super(code, message, {
      details: middlewareDetails(middlewareName, registrationId, scopeId, handlerLabel),
    })
    this.middlewareName = middlewareName
    this.registrationId = registrationId
    this.scopeId = scopeId
    this.handlerLabel = handlerLabel
  }
}

/** One handler tried to advance the same downstream chain more than once. */
export class MiddlewareNextRepeatedError extends MiddlewareRegistrationError<'MIDDLEWARE_NEXT_REPEATED'> {
  /**
   * Create an error for a repeated `next()` call.
   *
   * @param middlewareName - Diagnostic name of the middleware chain.
   * @param registrationId - Identity of the handler registration.
   * @param scopeId - Identity of the scope that owns the handler.
   * @param handlerLabel - Diagnostic label of the handler.
   */
  constructor(
    middlewareName: string,
    registrationId: string,
    scopeId: string,
    handlerLabel: string,
  ) {
    super(
      'MIDDLEWARE_NEXT_REPEATED',
      `middleware handler "${handlerLabel}" called next() more than once`,
      middlewareName,
      registrationId,
      scopeId,
      handlerLabel,
    )
    this.name = 'MiddlewareNextRepeatedError'
  }
}

/** A settled handler tried to advance a downstream chain it never started. */
export class MiddlewareNextInactiveError extends MiddlewareRegistrationError<'MIDDLEWARE_NEXT_INACTIVE'> {
  /**
   * Create an error for a first `next()` call after handler settlement.
   *
   * @param middlewareName - Diagnostic name of the middleware chain.
   * @param registrationId - Identity of the handler registration.
   * @param scopeId - Identity of the scope that owns the handler.
   * @param handlerLabel - Diagnostic label of the handler.
   */
  constructor(
    middlewareName: string,
    registrationId: string,
    scopeId: string,
    handlerLabel: string,
  ) {
    super(
      'MIDDLEWARE_NEXT_INACTIVE',
      `middleware handler "${handlerLabel}" called next() after it settled`,
      middlewareName,
      registrationId,
      scopeId,
      handlerLabel,
    )
    this.name = 'MiddlewareNextInactiveError'
  }
}

/** A middleware chain reached its end without a terminal operation. */
export class MiddlewareUnterminatedError extends HarnessError<'MIDDLEWARE_UNTERMINATED'> {
  /** Diagnostic name of the middleware chain. */
  readonly middlewareName: string
  /** Scope that accepted the invocation. */
  readonly originScopeId: string

  /**
   * Create an error for a fully delegated chain with no terminal.
   *
   * @param middlewareName - Diagnostic name of the middleware chain.
   * @param originScopeId - Scope that accepted the invocation.
   */
  constructor(middlewareName: string, originScopeId: string) {
    super(
      'MIDDLEWARE_UNTERMINATED',
      `middleware "${middlewareName}" reached the end of its chain without a terminal`,
      { details: { middlewareName, originScopeId } },
    )
    this.name = 'MiddlewareUnterminatedError'
    this.middlewareName = middlewareName
    this.originScopeId = originScopeId
  }
}

/** A Scope wait would include work held by the current asynchronous call chain. */
export class ScopeReentrantWaitError extends HarnessError<'SCOPE_REENTRANT_WAIT'> {
  /** Identity of the scope whose subtree would be awaited. */
  readonly scopeId: string
  /** Operation that would create the wait cycle. */
  readonly operation: string
  /** Active scope identities inherited by the current call chain. */
  readonly activeScopeIds: readonly string[]
  /** Active callback registration, when the chain currently holds one. */
  readonly activeRegistrationId?: string

  /**
   * Create an error for a scope wait cycle.
   *
   * @param scopeId - Identity of the scope whose subtree would be awaited.
   * @param operation - Operation that would create the wait cycle.
   * @param activeScopeIds - Active scope identities inherited by the current chain.
   * @param activeRegistrationId - Active callback registration, when present.
   */
  constructor(
    scopeId: string,
    operation: string,
    activeScopeIds: readonly string[],
    activeRegistrationId?: string,
  ) {
    super(
      'SCOPE_REENTRANT_WAIT',
      `${operation} would wait for work held by the current scope call chain`,
      {
        details: {
          scopeId,
          operation,
          activeScopeIds: [...activeScopeIds],
          ...(activeRegistrationId === undefined ? {} : { activeRegistrationId }),
        },
      },
    )
    this.name = 'ScopeReentrantWaitError'
    this.scopeId = scopeId
    this.operation = operation
    this.activeScopeIds = activeScopeIds
    if (activeRegistrationId !== undefined) this.activeRegistrationId = activeRegistrationId
  }
}

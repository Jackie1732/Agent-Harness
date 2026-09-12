export { createEventName, createMiddlewareName } from './names.js'
export {
  EventListenersFailedError,
  EventNameConflictError,
  MiddlewareNameConflictError,
  MiddlewareNextInactiveError,
  MiddlewareNextRepeatedError,
  MiddlewareUnterminatedError,
  ScopeInactiveError,
  ScopeNotPublishedError,
  ScopeReentrantWaitError,
} from './errors.js'

export type { ExtensionErrorCode } from './errors.js'
export type {
  EventListener,
  EventListenerFailure,
  EventName,
  MiddlewareHandler,
  MiddlewareName,
  MiddlewareNext,
  RegistrationHandle,
  RegistrationId,
  RegistrationStatus,
  RootScope,
  Scope,
  ScopeId,
  ScopeNodeSnapshot,
  ScopeRegistrationSnapshot,
  ScopeSnapshot,
  ScopeStatus,
} from './types.js'

export { SessionError } from './errors.js'
export {
  formatSessionAddress,
  formatSessionEventId,
  parseSessionAddress,
  parseSessionEventId,
  parseSessionId,
  sessionLogPosition,
  sessionSequence,
  systemSessionIdentitySource,
} from './ids.js'
export {
  createDurableEventCatalog,
  createDurableEventDefinition,
  sessionEndedEvent,
} from './event-catalog.js'
export { MemorySessionBackend } from './memory-backend.js'
export { FileSessionBackend } from './file-backend.js'
export { projectSession } from './projection.js'
export { SessionRepository } from './repository.js'
export { createSessionRepositoryComponent, SessionRepositoryKey } from './component.js'
export {
  SESSION_ENVELOPE_VERSION,
  SESSION_FORMAT_VERSION,
  SESSION_HEADER_MAX_BYTES,
} from './types.js'

export type { SessionErrorCode } from './errors.js'
export type {
  SessionAddress,
  SessionEventId,
  SessionId,
  SessionIdentitySource,
  SessionLogPosition,
  SessionSequence,
} from './ids.js'
export type {
  DurableEventCatalog,
  DurableEventDefinition,
  DurableEventDefinitionOptions,
} from './event-catalog.js'
export type { FileSessionBackendOptions } from './file-backend.js'
export type { MemorySessionBackendOptions } from './memory-backend.js'
export type { LocalStoredSession, SessionBackend, SessionWriter } from './backend.js'
export type { SessionRepositoryOptions } from './repository.js'
export type { SessionHandle, SessionHandleStatus } from './session-handle.js'
export type {
  CommittedSessionEvent,
  IgnoredSessionEvent,
  IncompleteSessionTail,
  OpaqueSessionEvent,
  SessionEndedPayload,
  SessionEventRecord,
  SessionHeader,
  SessionHistorySegment,
  SessionLifecycle,
  SessionProjection,
  SessionProjectionCoverage,
  SessionProjectionResult,
  SessionSnapshot,
  StoredSessionEvent,
} from './types.js'

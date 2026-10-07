/** Stable code-to-status mapping; domain codes do not select HTTP status. */
export const API_HTTP_STATUS = {
  API_VERSION_UNSUPPORTED: 400, API_PROTOCOL_INVALID: 400,
  API_UNAUTHORIZED: 401, API_FORBIDDEN: 403, API_TARGET_NOT_FOUND: 404,
  API_INSTANCE_MISMATCH: 409, API_BUSY: 409, API_INACTIVE: 409,
  API_CAPACITY_EXCEEDED: 429, API_KEY_CONFLICT: 409, API_CURSOR_INVALID: 409,
  API_OPERATION_REJECTED: 409, API_LIMIT_EXCEEDED: 413,
  API_EVIDENCE_INCOMPLETE: 409, API_RECOVERY_REQUIRED: 409, API_INTERNAL_ERROR: 500,
} as const
export type ApiErrorCode = keyof typeof API_HTTP_STATUS
export type ApiAcceptance = 'not-accepted' | 'unknown' | 'not-applicable'
export interface ApiErrorData {
  readonly code: ApiErrorCode
  readonly message: string
  readonly acceptance: ApiAcceptance
  readonly domainCode: string | null
}

/** Parser errors expose no input, paths, stack or domain exception details on the wire. */
export class ProtocolError extends TypeError {
  constructor(readonly code: 'API_VERSION_UNSUPPORTED' | 'API_PROTOCOL_INVALID' | 'API_LIMIT_EXCEEDED', message = 'Control data rejected') {
    super(message)
    this.name = 'ProtocolError'
  }
}

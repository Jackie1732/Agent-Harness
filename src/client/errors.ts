import type { ApiAcceptance, ApiErrorCode } from '../protocol/index.js'

/** A validated server rejection, including its confirmed domain acceptance classification. */
export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode, message: string, readonly acceptance: ApiAcceptance, readonly domainCode: string | null) {
    super(message); this.name = 'ApiError'
  }
}
/** No valid RPC receipt was obtained; accepted work is not implicitly retried. */
export class ClientTransportError extends Error {
  constructor(readonly acceptance: ApiAcceptance) { super('Control transport failed'); this.name = 'ClientTransportError' }
}
/** Cancellation stops only this client's connection and observation. */
export class ClientAbortError extends Error {
  constructor(readonly acceptance: ApiAcceptance) { super('Control request aborted'); this.name = 'ClientAbortError' }
}

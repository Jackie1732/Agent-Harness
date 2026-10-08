import { ProtocolError } from '../protocol/index.js'
import type { ApiErrorData, ControlMethod } from '../protocol/index.js'
import { controlFailure } from '../control/errors.js'

export { ControlRejection as ApiRejection, readMethod } from '../control/errors.js'

/**
 * Protocol parsing belongs to the transport; domain acceptance comes from the shared control owner.
 * @param error Protocol, domain or network failure.
 * @param method Identified control method, if decoding completed.
 * @param invoked Whether the domain dispatcher was entered.
 * @param domainReturned Whether a mutation returned before a later failure.
 * @returns Sanitized response diagnostic and acceptance classification.
 */
export function apiFailure(error: unknown, method: ControlMethod | undefined, invoked: boolean, domainReturned: boolean): ApiErrorData {
  if (error instanceof ProtocolError) return { code: error.code, message: 'Invalid control request',
    acceptance: domainReturned ? 'unknown' : 'not-accepted', domainCode: null }
  return controlFailure(error, method, invoked, domainReturned)
}

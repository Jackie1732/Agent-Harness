import { HarnessError } from '../foundation/error.js'
import { ApiError, ClientAbortError, ClientTransportError } from '../client/errors.js'
import type { ApiAcceptance } from '../protocol/index.js'

/** Failures owned by the local operator; parameters and credentials stay out of diagnostics. */
export class OperatorError extends Error {
  constructor(readonly code: string, readonly exitCode: number, readonly acceptance: ApiAcceptance = 'not-accepted') {
    super(code); this.name = 'OperatorError'
  }
}

/** Keep domain acceptance independent of process exit and resource cleanup. */
export function operatorFailure(error: unknown) {
  if (error instanceof ApiError) return { acceptance: error.acceptance, code: error.code, domainCode: error.domainCode,
    message: 'Control request failed', exitCode: error.acceptance === 'unknown' ? 4 : 3 }
  if (error instanceof ClientAbortError || error instanceof ClientTransportError) return { acceptance: error.acceptance,
    code: error instanceof ClientAbortError ? 'OPERATOR_ABORTED' : 'OPERATOR_CONNECTION_FAILED', domainCode: null,
    message: 'Control connection did not return a receipt', exitCode: error.acceptance === 'unknown' ? 4 : 1 }
  if (error instanceof OperatorError) return { acceptance: error.acceptance, code: error.code, domainCode: null,
    message: error.code, exitCode: error.exitCode }
  return { acceptance: 'not-accepted' as const, code: 'OPERATOR_FAILED', domainCode: error instanceof HarnessError ? error.code : null,
    message: 'Operator operation failed', exitCode: error instanceof HarnessError && error.code.includes('CONFIG_INVALID') ? 2 : 1 }
}

import { HarnessError } from '../foundation/error.js'

/** Protocol diagnostics never serialize provider exceptions, paths, causes or private values. */
export function hostDiagnostic(error: unknown) {
  return Object.freeze({ code: error instanceof HarnessError ? error.code : 'HOST_INTERNAL_ERROR', message: 'host-operation-failed' })
}

/** Distinguish rejected command input from storage, execution and cleanup failures. */
export function isHostUsageError(error: unknown): boolean {
  return error instanceof HarnessError && [
    'HOST_CONFIG_INVALID', 'HOST_PROTOCOL_INVALID', 'HOST_NOT_READY', 'HOST_BUSY', 'HOST_INACTIVE',
    'AGENT_INPUT_INVALID', 'AGENT_WAIT_INVALID', 'AGENT_WAIT_TERMINAL', 'AGENT_LIMIT_EXCEEDED', 'AGENT_BUSY', 'AGENT_INACTIVE',
  ].includes(error.code)
}

import { HarnessError } from '../foundation/error.js'

export const hostErrorCodes = [
  'HOST_CONFIG_INVALID', 'HOST_BOOTSTRAP_AMBIGUOUS', 'HOST_BINDING_CONFLICT',
  'HOST_LOCKED', 'HOST_NOT_READY', 'HOST_BUSY', 'HOST_RECOVERY_REQUIRED',
  'HOST_ROUTE_BLOCKED', 'HOST_PROTOCOL_INVALID', 'HOST_OUTPUT_FAILED', 'HOST_INACTIVE', 'HOST_CLEANUP_FAILED', 'HOST_REENTRANT_WAIT',
] as const
export type HostErrorCode = typeof hostErrorCodes[number]

/** Stable Host diagnostics exclude configuration values, credentials and provider errors. */
export class HostError extends HarnessError<HostErrorCode> {
  constructor(
    code: HostErrorCode,
    reason: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
    options: { readonly cause?: unknown } = {},
  ) {
    super(code, reason, { details, ...options })
    this.name = 'HostError'
  }
}

import { hostExitCode } from '../host/cli-interactive.js'
import type { HostRunReport } from '../host/report-data.js'
import type { ControlMethod } from '../protocol/index.js'
import type { SessionProjectionCoverage } from '../session/types.js'
import type { ResolvedOperatorProfile } from './profile.js'
import type { HostShutdownMode } from '../host/runtime.js'
import type { OperatorResult, OperatorScope, OperatorAcceptance } from './types.js'
import { operatorFailure } from './errors.js'

/** Construct the operator envelope from this observation, preserving its actual cuts and scope. */
export function operatorResult(command: string, profile: ResolvedOperatorProfile | null, scope: OperatorScope,
  result: unknown, operationId: string | null = null, error?: unknown): OperatorResult {
  const failure = error === undefined ? null : operatorFailure(error)
  type Evidence = { readonly cuts?: readonly SessionProjectionCoverage[]; readonly instanceId?: string; readonly sessionId?: string }
  const outer = result as Evidence & { readonly observation?: Evidence } | null
  const value = ['root.wait', 'message.wait', 'delegation.wait', 'workflow.wait'].includes(command) ? outer?.observation ?? outer : outer
  const acceptance: OperatorAcceptance = failure?.acceptance ?? (operationId === null ? 'not-applicable' : 'accepted')
  return { operatorVersion: 1, kind: 'operator-result', command, profileKey: profile?.profileKey ?? null, operationId,
    status: failure === null ? 'ok' : acceptance === 'unknown' ? 'unknown' : failure.exitCode === 10 ? 'pending'
      : failure.exitCode === 3 || failure.exitCode === 2 ? 'rejected' : 'failed',
    acceptance, scope: { ...scope, instanceId: value?.instanceId ?? scope.instanceId, sessionId: value?.sessionId ?? scope.sessionId },
    receivedAt: result === null && error === undefined ? null : new Date().toISOString(), cuts: value?.cuts ?? null,
    result, error: failure === null ? null : { code: failure.code, domainCode: failure.domainCode, message: failure.message },
    closing: { status: profile?.connection.kind === 'local' ? 'pending' : 'not-owned', mode: null } }
}

/** Preserve returned effect evidence when local resource release fails; null mode owns no Host. */
export function operatorCloseFailure(result: OperatorResult, mode: HostShutdownMode | null): OperatorResult {
  return { ...result, status: 'failed', closing: { status: mode === null ? 'not-owned' : 'failed', mode },
    error: result.error ?? { code: 'OPERATOR_CLOSE_FAILED', domainCode: null, message: 'Owned resources did not release successfully' } }
}

/** Querying a failed Root succeeds; only run/drive interprets Host execution settlement. */
export function operatorExitCode(result: OperatorResult, method?: ControlMethod): number {
  if (result.acceptance === 'unknown') return 4
  if (result.closing.status === 'failed') return 1
  if (result.error !== null) {
    if (result.error.code === 'OPERATOR_RUN_UNKNOWN_REQUIRED') return 10
    if (result.error.code.startsWith('OPERATOR_USAGE') || result.error.code === 'OPERATOR_LOCAL_INSTANCE_COMMAND'
      || ['OPERATOR_INTENT_INVALID', 'OPERATOR_BINDING_CHANGED'].includes(result.error.code)
      || result.error.domainCode?.includes('CONFIG_INVALID')) return 2
    return result.status === 'rejected' ? 3 : 1
  }
  if (result.status === 'pending') return 10
  const raw = result.result as { readonly run?: { readonly result: unknown } | null } | null
  const value = (raw?.run?.result ?? result.result) as { readonly status?: string; readonly report?: HostRunReport } | null
  if (value?.status === 'timeout' || value?.status === 'host-closed') return 10
  if ((method === 'host.run' || result.command === 'task.submit' || result.command === 'task.answer' || result.command === 'run-once') && value?.report !== undefined) {
    return hostExitCode(value.report)
  }
  return 0
}

import { HarnessError } from '../foundation/error.js'
import { ProtocolError } from '../protocol/index.js'
import type { ApiAcceptance, ApiErrorCode, ControlMethod } from '../protocol/index.js'

/** A deliberate API policy rejection; no domain method has run unless specified. */
export class ApiRejection extends Error {
  constructor(readonly code: ApiErrorCode, readonly acceptance: ApiAcceptance = 'not-accepted') { super('Request rejected'); this.name = 'ApiRejection' }
}
/** Read methods cannot accept a domain mutation. */
export function readMethod(method: ControlMethod): boolean {
  return method.endsWith('.get') || method.endsWith('.wait') || ['host.status', 'session.events', 'workflow.output', 'workflow.artifact'].includes(method)
}
/** Map structured, owner-defined diagnostics without matching private error messages. */
export function apiFailure(error: unknown, method: ControlMethod | undefined, invoked: boolean) {
  const read = method !== undefined && readMethod(method)
  if (error instanceof ApiRejection) return { code: error.code, message: 'Request rejected', acceptance: error.acceptance, domainCode: null }
  if (error instanceof ProtocolError) return { code: error.code, message: 'Invalid control request', acceptance: 'not-accepted' as const, domainCode: null }
  const domainCode = error instanceof HarnessError && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : null
  let code: ApiErrorCode = 'API_INTERNAL_ERROR'
  let knownRejection = false
  const reasonCode = error instanceof HarnessError ? error.details?.reasonCode : undefined
  if (domainCode !== null) {
    if (reasonCode === 'operation-rejected' || reasonCode === 'answer-wait-terminal' || reasonCode === 'answer-root-stopped') { code = 'API_OPERATION_REJECTED'; knownRejection = true }
    else if (reasonCode === 'input-capacity' || domainCode === 'SUBAGENT_CAPACITY') { code = 'API_CAPACITY_EXCEEDED'; knownRejection = true }
    else if (reasonCode === 'input-byte-limit') { code = 'API_LIMIT_EXCEEDED'; knownRejection = true }
    else if (['HOST_BUSY', 'AGENT_BUSY', 'AGENT_RECOVERY_BUSY'].includes(domainCode)) { code = 'API_BUSY'; knownRejection = true }
    else if (['HOST_INACTIVE', 'HOST_NOT_READY', 'AGENT_INACTIVE', 'SUBAGENT_INACTIVE'].includes(domainCode)) { code = 'API_INACTIVE'; knownRejection = true }
    else if (domainCode.includes('RECOVERY_REQUIRED') || domainCode.includes('COMMIT_UNKNOWN')) code = 'API_RECOVERY_REQUIRED'
    else if (domainCode.includes('KEY_CONFLICT') || domainCode.includes('REQUEST_CONFLICT') || domainCode === 'HOST_BINDING_CONFLICT') { code = 'API_KEY_CONFLICT'; knownRejection = true }
    else if (domainCode === 'HOST_TARGET_NOT_FOUND') { code = 'API_TARGET_NOT_FOUND'; knownRejection = true }
    else if (domainCode === 'HOST_CURSOR_INVALID') { code = 'API_CURSOR_INVALID'; knownRejection = true }
    else if (domainCode.includes('LIMIT_EXCEEDED')) code = 'API_LIMIT_EXCEEDED'
    else if (['AGENT_WAIT_INVALID', 'AGENT_WAIT_TERMINAL', 'SUBAGENT_AUTHORITY_DENIED', 'SUBAGENT_BUDGET_EXHAUSTED', 'SUBAGENT_STATE_INVALID', 'SUBAGENT_REQUEST_INVALID'].includes(domainCode)) {
      code = 'API_OPERATION_REJECTED'; knownRejection = true
    }
    else if (domainCode.includes('EVIDENCE_INCOMPLETE') || domainCode.includes('SOURCE_INVALID')) code = 'API_EVIDENCE_INCOMPLETE'
  }
  if (invoked && method !== undefined && ['root.cancel', 'delegation.cancel', 'workflow.cancel'].includes(method)
    && code !== 'API_BUSY' && code !== 'API_INACTIVE' && code !== 'API_KEY_CONFLICT') knownRejection = false
  return { code, message: 'Request failed', acceptance: read ? 'not-applicable' as const : !invoked || knownRejection ? 'not-accepted' as const : 'unknown' as const, domainCode }
}

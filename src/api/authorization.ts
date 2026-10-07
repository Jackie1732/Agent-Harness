import type { AnyControlRequest, RootObservation, SessionTarget } from '../protocol/index.js'
import type { AtomicHost } from '../host/runtime.js'
import type { ResolvedHostSpec } from '../host/config.js'
import type { ApiPrincipal } from './config.js'
import { ApiRejection } from './errors.js'
import { HarnessError } from '../foundation/error.js'

/** Stable namespaces preserve identity across reconnection and certificate rotation. */
export function principalNamespace(principal: ApiPrincipal): string { return `api:${principal.principalKey}` }
export function principalControlKey(principal: ApiPrincipal, key: string): string { return `${principalNamespace(principal)}:${key}` }
function agentGrant(principal: ApiPrincipal, key: string): void {
  if (!principal.agentKeys.includes(key)) throw new ApiRejection('API_FORBIDDEN')
}
function workflowGrant(principal: ApiPrincipal, key: string): void {
  if (!principal.workflowKeys.includes(key)) throw new ApiRejection('API_FORBIDDEN')
}
function rootWorkflow(principal: ApiPrincipal, root: RootObservation, spec: ResolvedHostSpec): void {
  if (root.source.kind !== 'workflow') return
  const assignment = root.source.assignment
  const entry = spec.schemaVersion === 3 && spec.workflows.kind === 'enabled'
    ? spec.workflows.definitions.find(entry => `ah-session:${entry.sessionId}` === assignment.address) : undefined
  if (entry === undefined) throw new ApiRejection('API_EVIDENCE_INCOMPLETE', 'not-applicable')
  workflowGrant(principal, entry.definition.workflowKey)
}
async function targetGrant(principal: ApiPrincipal, target: SessionTarget, host: AtomicHost, spec: ResolvedHostSpec): Promise<void> {
  switch (target.kind) {
    case 'member': agentGrant(principal, target.agentKey); return
    case 'workflow': workflowGrant(principal, target.workflowKey); return
    case 'child':
      agentGrant(principal, target.parentAgentKey)
      rootWorkflow(principal, await host.read().root(target.parentAgentKey, target.parentRoot), spec)
      return
  }
}
/** Verify method and exact target grants before invoking any mutation. IDs never grant access. */
export async function authorizeRequest(principal: ApiPrincipal, request: AnyControlRequest, host: AtomicHost, spec: ResolvedHostSpec): Promise<void> {
  if (!principal.methods.includes(request.method)) throw new ApiRejection('API_FORBIDDEN')
  const params = request.params
  if ('agentKey' in params) agentGrant(principal, params.agentKey)
  if ('workflowKey' in params) workflowGrant(principal, params.workflowKey)
  if ('parentAgentKey' in params) {
    agentGrant(principal, params.parentAgentKey)
    rootWorkflow(principal, await host.read().root(params.parentAgentKey, params.parentRoot), spec)
  }
  if (request.method === 'session.events') await targetGrant(principal, request.params.target, host, spec)
  if (request.method === 'input.answer') {
    let prior
    try { prior = host.read().input(request.params.agentKey, { namespace: principalNamespace(principal), key: request.params.submissionKey }) }
    catch (error) { if (!(error instanceof HarnessError) || error.code !== 'HOST_TARGET_NOT_FOUND') throw error }
    if (prior?.wait !== undefined && prior.wait !== null) rootWorkflow(principal, host.read().answerRoot(request.params.agentKey, prior.wait), spec)
    rootWorkflow(principal, await host.read().answerRoot(request.params.agentKey, request.params.wait), spec)
  }
  if (request.method === 'root.cancel' && (await host.read().root(request.params.agentKey, request.params.rootId)).source.kind !== 'ordinary') {
    throw new ApiRejection('API_FORBIDDEN')
  }
  if ('expectedInstanceId' in params && params.expectedInstanceId !== host.instanceId) throw new ApiRejection('API_INSTANCE_MISMATCH')
}

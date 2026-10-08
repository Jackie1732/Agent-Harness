import type { RootObservation, SessionTarget } from '../protocol/index.js'
import { CONTROL_METHODS } from '../protocol/index.js'
import type { AtomicHost } from '../host/runtime.js'
import type { ResolvedHostSpec } from '../host/config.js'
import { isLocalHostMember } from '../host/config.js'
import type { AnyControlOperation, ControlCaller } from './types.js'
import { ControlRejection } from './errors.js'
import { HarnessError } from '../foundation/error.js'

/**
 * Derive local grants from the Host's configured owners using the profile's stable identity.
 * @param spec Resolved Host configuration.
 * @param profileKey Validated stable operator profile identity.
 * @returns Caller grants for local members and configured Workflows.
 */
export function localControlCaller(spec: ResolvedHostSpec, profileKey: string): ControlCaller {
  return Object.freeze({ namespace: `local:${profileKey}`, methods: CONTROL_METHODS,
    agentKeys: Object.freeze(spec.members.filter(isLocalHostMember).map(member => member.agentKey)),
    workflowKeys: Object.freeze(spec.schemaVersion === 3 && spec.workflows.kind === 'enabled'
      ? spec.workflows.definitions.map(entry => entry.definition.workflowKey) : []) })
}
function agentGrant(caller: ControlCaller, key: string): void {
  if (!caller.agentKeys.includes(key)) throw new ControlRejection('API_FORBIDDEN')
}
function workflowGrant(caller: ControlCaller, key: string): void {
  if (!caller.workflowKeys.includes(key)) throw new ControlRejection('API_FORBIDDEN')
}
function rootWorkflow(caller: ControlCaller, root: RootObservation, spec: ResolvedHostSpec): void {
  if (root.source.kind !== 'workflow') return
  const assignment = root.source.assignment
  const entry = spec.schemaVersion === 3 && spec.workflows.kind === 'enabled'
    ? spec.workflows.definitions.find(entry => `ah-session:${entry.sessionId}` === assignment.address) : undefined
  if (entry === undefined) throw new ControlRejection('API_EVIDENCE_INCOMPLETE', 'not-applicable')
  workflowGrant(caller, entry.definition.workflowKey)
}
async function targetGrant(caller: ControlCaller, target: SessionTarget, host: AtomicHost, spec: ResolvedHostSpec): Promise<void> {
  switch (target.kind) {
    case 'member': agentGrant(caller, target.agentKey); return
    case 'workflow': workflowGrant(caller, target.workflowKey); return
    case 'child':
      agentGrant(caller, target.parentAgentKey)
      rootWorkflow(caller, await host.read().root(target.parentAgentKey, target.parentRoot), spec)
      return
  }
}
/**
 * Verify method and exact target grants before invoking any mutation. IDs never grant access.
 * @param host Current Host instance providing immutable authorization evidence.
 * @param spec Resolved member and Workflow identities.
 * @param caller Authenticated grants and durable operation namespace.
 * @param request Existing control method and its typed parameters.
 * @returns Resolution when all required target and instance checks pass.
 */
export async function authorizeControl(host: AtomicHost, spec: ResolvedHostSpec, caller: ControlCaller, request: AnyControlOperation): Promise<void> {
  if (!caller.methods.includes(request.method)) throw new ControlRejection('API_FORBIDDEN')
  const params = request.params
  if ('agentKey' in params) agentGrant(caller, params.agentKey)
  if ('workflowKey' in params) workflowGrant(caller, params.workflowKey)
  if ('parentAgentKey' in params) {
    agentGrant(caller, params.parentAgentKey)
    rootWorkflow(caller, await host.read().root(params.parentAgentKey, params.parentRoot), spec)
  }
  if (request.method === 'session.events') await targetGrant(caller, request.params.target, host, spec)
  if (request.method === 'input.answer') {
    let prior
    try { prior = host.read().input(request.params.agentKey, { namespace: caller.namespace, key: request.params.submissionKey }) }
    catch (error) { if (!(error instanceof HarnessError) || error.code !== 'HOST_TARGET_NOT_FOUND') throw error }
    if (prior?.wait !== undefined && prior.wait !== null) rootWorkflow(caller, host.read().answerRoot(request.params.agentKey, prior.wait), spec)
    rootWorkflow(caller, await host.read().answerRoot(request.params.agentKey, request.params.wait), spec)
  }
  if (request.method === 'root.cancel' && (await host.read().root(request.params.agentKey, request.params.rootId)).source.kind !== 'ordinary') {
    throw new ControlRejection('API_FORBIDDEN')
  }
  if ('expectedInstanceId' in params && params.expectedInstanceId !== host.instanceId) throw new ControlRejection('API_INSTANCE_MISMATCH')
}

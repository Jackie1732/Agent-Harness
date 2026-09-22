import type { DelegationCapabilities, DelegationRequirements, DelegationWorkspace } from './contract.js'
import { SubagentError } from './errors.js'

/** Portable paths compare whole segments; an output prefix never grants its siblings. */
export function delegationPathAllowed(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

/** Every authority must grant every required capability; no environment-based inheritance. */
export function authorizeDelegation(
  required: DelegationRequirements,
  workspace: DelegationWorkspace,
  authorities: readonly [DelegationCapabilities, DelegationCapabilities, ...DelegationCapabilities[]],
): void {
  for (const authority of authorities) {
    if (!authority.models.some(model => model.providerId === required.providerId && model.model === required.model)
      || required.tools.some(tool => !authority.tools.includes(tool))) denied('required-capability')
    if (workspace.kind === 'none') continue
    const grant = authority.workspaces.find(item => item.resourceId === workspace.resourceId)
    if (grant === undefined || !grant.modes.includes(workspace.kind)
      || workspace.readFiles.some(path => !delegationPathAllowed(path, grant.readPrefixes))
      || workspace.writePrefixes.some(path => !delegationPathAllowed(path, grant.writePrefixes))) denied('workspace-scope')
  }
}
function denied(reason: string): never { throw new SubagentError('SUBAGENT_AUTHORITY_DENIED', reason) }

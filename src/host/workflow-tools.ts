import { array, exact, integer, record, text, unique, choice } from '../agent/validation.js'
import { decodeWorkspaceToolConfig } from '../tool/workspace-config.js'
import type { WorkspaceToolConfig } from '../tool/workspace-config.js'
import type { HostToolConfig } from './config-types.js'

export type HostWorkflowTools = { readonly kind: 'none' }
  | Omit<Extract<WorkspaceToolConfig, { kind: 'workspace-text' }>, 'kind'> & {
    readonly kind: 'workspace'
    readonly resourceIds: readonly string[]
    readonly policy: Extract<HostToolConfig, { kind: 'workspace-read-text' }>['policy']
  }

/** Host authority for work tools is independent of ordinary Agent tool selection. */
export function decodeHostWorkflowTools(value: unknown): HostWorkflowTools {
  const input = record(value)
  if (input.kind === 'none') { exact(input, ['kind']); return { kind: 'none' } }
  choice(input.kind, ['workspace'])
  const { kind: _kind, resourceIds, policy, ...fields } = input
  const tools = decodeWorkspaceToolConfig({ kind: 'workspace-text', ...fields }) as Extract<WorkspaceToolConfig, { kind: 'workspace-text' }>
  const resources = array(resourceIds, 64).map(value => text(value, 128)); unique(resources)
  const p = record(policy); exact(p, ['policyId', 'version', 'decision', 'reasonCode'])
  return { ...tools, kind: 'workspace', resourceIds: resources, policy: { policyId: text(p.policyId, 128),
    version: integer(p.version, 1), decision: choice(p.decision, ['allow', 'deny'] as const), reasonCode: text(p.reasonCode, 128) } }
}

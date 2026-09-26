import type { WorkflowAssignment, WorkflowAttempt } from '../workflow/types.js'
import { sameWorkflowValue } from '../workflow/work-binding.js'
import { WorkspaceAuthority } from '../subagent/workspace.js'
import type { WorkspaceLease } from '../subagent/workspace.js'
import type { Clock } from '../foundation/clock.js'
import type { ResolvedHostLocalMember, ResolvedHostSpec } from './config-types.js'
import type { HostExecutionExtensions } from './slot.js'
import { HostError } from './errors.js'

type Selection = Pick<WorkflowAttempt, 'workspace' | 'toolNames'>

/** Check the actual Host tool recipe before acquiring a work lease. */
export function assertWorkTools(member: ResolvedHostLocalMember, selection: Selection): void {
  const tools = member.workflowTools
  const { workspace, toolNames } = selection
  if (workspace.kind === 'none') {
    if (toolNames.length !== 0) throw new HostError('HOST_BINDING_CONFLICT', 'work-tools-require-workspace')
    return
  }
  if (tools?.kind !== 'workspace' || !tools.resourceIds.includes(workspace.resourceId)
    || toolNames.some(name => name !== 'read_text' && name !== 'write_text'
      || name === 'read_text' && !tools.read || name === 'write_text' && (!tools.write || workspace.kind !== 'exclusive-write'))) {
    throw new HostError('HOST_BINDING_CONFLICT', 'work-tool-authority')
  }
}

/** Reserve managed ranges and measure the exact input files before the assignment commit. */
export async function prepareWorkWorkspace(member: ResolvedHostLocalMember, selection: Selection, authority: WorkspaceAuthority,
  expectedBaseline?: WorkflowAssignment['workspaceBaseline']): Promise<WorkspaceLease | undefined> {
  assertWorkTools(member, selection)
  if (selection.workspace.kind === 'none') return undefined
  const tools = member.workflowTools!
  if (tools.kind !== 'workspace') throw new HostError('HOST_BINDING_CONFLICT', 'work-tool-authority')
  const lease = authority.reserve(selection.workspace, tools.maxBaselineFiles, tools.maxBaselineBytes)
  try {
    await lease.checkWriteDirectories()
    const baseline = await lease.baseline()
    if (expectedBaseline != null && !sameWorkflowValue([baseline.rootIdentity, baseline.entries], [expectedBaseline.rootIdentity, expectedBaseline.entries])) {
      throw new HostError('HOST_BINDING_CONFLICT', 'work-baseline-changed')
    }
    return lease
  }
  catch (cause) {
    try { await lease.dispose() }
    catch (cleanup) { throw new HostError('HOST_CLEANUP_FAILED', 'work-baseline-cleanup', {}, { cause: new AggregateError([cause, cleanup]) }) }
    throw cause
  }
}

/** Only tools in the frozen grant are installed into the new execution generation. */
export function workExecutionTools(member: ResolvedHostLocalMember, selection: Selection, lease: WorkspaceLease | undefined): HostExecutionExtensions {
  const tools = member.workflowTools
  if (lease === undefined || tools?.kind !== 'workspace' || selection.toolNames.length === 0) return {
    toolConfig: { kind: 'none' }, ...(lease === undefined ? {} : { workspaceLease: lease }),
  }
  const { resourceIds: _ids, policy, ...limits } = tools
  return { toolConfig: { kind: 'none' }, workspaceLease: lease, workspaceAccess: lease, workspacePolicy: policy,
    workspaceTools: { ...limits, kind: 'workspace-text', read: selection.toolNames.includes('read_text'), write: selection.toolNames.includes('write_text') } }
}

/** Validate configured work resources and pre-existing output directories before creating any Session. */
export async function validateWorkflowWorkspaces(spec: ResolvedHostSpec, clock: Clock): Promise<void> {
  if (spec.schemaVersion !== 3 || spec.workflows.kind !== 'enabled') return
  const authority = await WorkspaceAuthority.create(spec.workspaceResources, [], [spec.storage.root], clock)
  try {
    for (const { definition } of spec.workflows.definitions) for (const node of definition.nodes) {
      const member = spec.members.find(member => member.kind === 'local' && member.agentKey === node.executor)
      if (member?.kind !== 'local') throw new HostError('HOST_CONFIG_INVALID', 'workflow-member-local')
      for (const attempt of node.attempts) {
        const lease = await prepareWorkWorkspace(member, attempt, authority)
        await lease?.dispose()
      }
    }
  } finally { await authority.dispose() }
}

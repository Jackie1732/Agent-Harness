import type { WorkflowAssignment } from './types.js'
import { invalidHistory } from './errors.js'

/** A recorded baseline covers exactly the assignment's explicit read set. */
export function validateWorkBaseline(work: WorkflowAssignment): void {
  const { workspace, workspaceBaseline: baseline } = work
  if (workspace.kind === 'none') {
    if (baseline !== null) invalidHistory('workspace-baseline-unexpected')
    return
  }
  if (baseline === null || baseline.resourceId !== workspace.resourceId
    || baseline.entries.length !== workspace.readFiles.length
    || baseline.entries.some((entry, index) => entry.path !== workspace.readFiles[index])) invalidHistory('workspace-baseline-source')
}

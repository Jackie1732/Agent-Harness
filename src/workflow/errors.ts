/** Invalid workflow definition or incompatible persisted workflow history. */
export class WorkflowError extends Error {
  constructor(readonly code: 'WORKFLOW_DEFINITION_INVALID' | 'WORKFLOW_HISTORY_INVALID' | 'WORKFLOW_ADMISSION_BLOCKED' | 'WORKFLOW_COMMIT_UNKNOWN', reason: string) {
    super(reason)
    this.name = 'WorkflowError'
  }
}

export function invalidDefinition(reason: string): never { throw new WorkflowError('WORKFLOW_DEFINITION_INVALID', reason) }
export function invalidHistory(reason: string): never { throw new WorkflowError('WORKFLOW_HISTORY_INVALID', reason) }

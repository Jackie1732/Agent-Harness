import type { WorkflowOutput } from './types.js'

/** Each attempt sees only its predeclared artifact path, while retaining the same logical output names. */
export function workOutputAtAttempt(output: WorkflowOutput, attempt: number) {
  return output.kind === 'text' ? output : { ...output, artifacts: output.artifacts.map(artifact => ({ ...artifact,
    source: artifact.source.kind === 'json-text' ? artifact.source : { kind: 'write-text' as const,
      path: 'path' in artifact.source ? artifact.source.path : artifact.source.paths[attempt - 1]! },
  })) }
}

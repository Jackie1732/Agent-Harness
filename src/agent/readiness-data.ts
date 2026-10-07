export type AgentReadinessBlock =
  | 'none' | 'ended' | 'recovery-required' | 'closing' | 'driver-active'
  | 'unsupported-input' | 'review-required' | 'waiting' | 'idle' | 'cleanup-incomplete' | 'capacity'

/** Pure scheduling observation from one committed Session prefix. */
export interface AgentReadiness {
  readonly sourcePosition: number
  readonly canRun: boolean
  readonly canMaintain: boolean
  readonly nextWakeAt: string | null
  readonly blockedBy: AgentReadinessBlock
  readonly counts: { readonly runnableInputs: number; readonly pendingMaintenance: number; readonly unsupportedInputs: number; readonly reviewRequiredInputs: number }
}

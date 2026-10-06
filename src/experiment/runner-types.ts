import type { HostRuntimeBindings } from '../host/slot.js'
import type { ExperimentLocation, ExperimentPlan } from './definition-types.js'
import type { ExperimentOutcome, ExperimentUnitState } from './journal-types.js'

/** Credentials and executable bindings are trusted runtime values, never serialized into a plan. */
export interface RunExperimentOptions {
  readonly mode?: 'fixture' | 'live'
  readonly signal?: AbortSignal
  readonly credentials?: Readonly<Record<string, string>>
  readonly fixtureBindings?: Readonly<Record<string, HostRuntimeBindings>>
  readonly continueUnstarted?: boolean
  readonly predecessorStopped?: true
  readonly expectedToken?: string
}
export interface ExperimentRunResult {
  readonly version: 1
  readonly location: ExperimentLocation
  readonly planDigest: string
  readonly finalized: boolean
  readonly units: readonly ExperimentUnitState[]
  readonly stoppedBy: 'completed' | 'policy' | 'cancelled' | 'unresolved'
}
export interface ExperimentMeasurement {
  readonly version: 1
  readonly unitKey: string
  readonly clock: 'performance.now'
  readonly environment: import('../foundation/json.js').JsonObject
  readonly initMs: number | null
  readonly driveMs: number | null
  readonly shutdownMs: number | null
  readonly totalMs: number
  readonly overdueMs: number
}
export interface ExperimentUnitRunResult {
  readonly outcome: ExperimentOutcome
  readonly reason: string
  readonly closure: 'confirmed' | 'failed' | 'unknown'
  readonly evidence: import('./evidence-types.js').ExperimentEvidence | null
  readonly measurement: ExperimentMeasurement
}
export type RunExperimentInput = ExperimentPlan | ExperimentLocation | string

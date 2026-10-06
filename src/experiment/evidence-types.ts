import type { SessionEventId, SessionId, SessionLogPosition } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import type { ResolvedHostSpec } from '../host/config.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import type { ExperimentLimits, ExperimentMediaType, ExperimentOutputSelector } from './definition-types.js'
import type { ExperimentMetrics, MetricsCoverage } from './metrics-types.js'

/** The receipt selects one submitted root; a Workflow selects one fixed coordinator. */
export type ExperimentEvidenceTarget = {
  readonly sessionId: SessionId
  readonly mediaType: ExperimentMediaType
} & (
  | { readonly kind: 'agent'; readonly inputEventId: SessionEventId; readonly selector: Exclude<ExperimentOutputSelector, { kind: 'workflow-artifact' }> }
  | { readonly kind: 'workflow'; readonly selector: Extract<ExperimentOutputSelector, { kind: 'workflow-artifact' }> }
)

export interface EvidenceFileDigest {
  readonly path: string
  readonly byteLength: number
  readonly sha256: string
}
export interface EvidenceSessionCut {
  readonly sessionId: SessionId
  readonly through: SessionLogPosition
  readonly role: 'selected' | 'context'
  readonly header: EvidenceFileDigest
  readonly log: EvidenceFileDigest
  readonly committedBytes: number
  readonly committedSha256: string
  readonly tail: { readonly byteOffset: number; readonly byteLength: number; readonly sha256: string } | null
}
export type ExperimentObservedOutput =
  | { readonly status: 'unavailable'; readonly reason: string; readonly sources: readonly WorkflowEventRef[] }
  | { readonly status: 'available'; readonly mediaType: ExperimentMediaType; readonly sourceMediaType: 'text/plain';
    readonly text: string; readonly byteLength: number; readonly sha256: string; readonly sources: readonly WorkflowEventRef[];
    readonly workspaceObservation: EvidenceFileDigest | null }

/** JSON evidence is portable metadata; raw framed bytes remain in the original store. */
export interface ExperimentEvidence {
  readonly version: 1
  readonly digestDomains: { readonly files: 'raw-sha256/v1'; readonly logs: 'framed-prefix-sha256/v1'; readonly metadata: 'sorted-json-sha256/v1' }
  readonly source: { readonly root: string; readonly maxRecordBytes: number; readonly maxLineageDepth: number }
  readonly scope: 'unit-local/v1' | 'historical-local/v1'
  readonly mode: 'fixture' | 'live' | 'historical'
  readonly selectedSessionIds: readonly SessionId[]
  /** Selected local cuts may be shorter than the same Session's inherited context cut. */
  readonly selections: readonly { readonly sessionId: SessionId; readonly through: SessionLogPosition | null }[]
  readonly sessions: readonly EvidenceSessionCut[]
  readonly coverage: MetricsCoverage
  readonly target: ExperimentEvidenceTarget | null
  readonly output: ExperimentObservedOutput
  readonly metrics: ExperimentMetrics
}
export interface CollectExperimentEvidenceInput {
  readonly recipe: ResolvedHostSpec
  readonly limits: Pick<ExperimentLimits, 'maxSessionCount' | 'maxEvents' | 'maxEvidenceBytes' | 'maxMetricSamples'>
  readonly scope: ExperimentEvidence['scope']
  readonly mode: ExperimentEvidence['mode']
  readonly selected?: readonly { readonly sessionId: SessionId; readonly through?: SessionLogPosition }[]
  readonly target?: ExperimentEvidenceTarget
}
export interface CollectedExperimentEvidence {
  readonly evidence: ExperimentEvidence
  readonly snapshots: readonly SessionSnapshot[]
}

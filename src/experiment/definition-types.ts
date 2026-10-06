import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { HostConfig, ResolvedHostSpec } from '../host/config.js'
import type { SessionAddress, SessionId } from '../session/ids.js'

/** Media types supported by the finite experiment input/output vocabulary. */
export type ExperimentMediaType = 'text/plain' | 'application/json'
export type ExperimentRule = {
  readonly ruleKey: string
  readonly normalize: readonly ('trim' | 'lf')[]
} & (
  | { readonly kind: 'text-exact'; readonly expected: string }
  | { readonly kind: 'text-includes-all'; readonly expected: readonly string[] }
  | { readonly kind: 'json-equals'; readonly expected: JsonValue }
  | { readonly kind: 'json-fields'; readonly fields: readonly { readonly path: readonly (string | number)[]; readonly expected: JsonValue }[] }
)
export interface ExperimentEvaluator {
  readonly evaluatorKey: string
  readonly version: string
  readonly implementationVersion: 'rules/v1'
  readonly rules: readonly ExperimentRule[]
}
export interface ExperimentMaterial {
  readonly logicalPath: string
  readonly mediaType: ExperimentMediaType
  readonly source: { readonly kind: 'inline'; readonly text: string } | { readonly kind: 'file'; readonly path: string }
  readonly expectedSha256: string | null
}
export interface ExperimentCase {
  readonly caseKey: string
  readonly task: string
  readonly materials: readonly ExperimentMaterial[]
  readonly output: { readonly outputKey: string; readonly mediaType: ExperimentMediaType }
  readonly primaryEvaluatorKey: string
}
/** A material is copied only to an explicitly named resource and relative path. */
export interface ExperimentMaterialBinding {
  readonly logicalPath: string
  readonly relativePath: string
  readonly resourceId: string | null
}
export type ExperimentOutputSelector = { readonly kind: 'root-final' }
  | { readonly kind: 'write-text'; readonly path: string }
  | { readonly kind: 'workflow-artifact'; readonly nodeKey: string; readonly artifactName: string }
export type ExperimentBinding = {
  readonly caseKey: string
  readonly inputMode: 'inline' | 'workspace'
  readonly materials: readonly ExperimentMaterialBinding[]
} & (
  | { readonly kind: 'agent'; readonly agentKey: string; readonly output: Extract<ExperimentOutputSelector, { kind: 'root-final' }> }
  | { readonly kind: 'workflow'; readonly workflowKey: string; readonly durationMs: number; readonly nodeTasks: readonly { readonly nodeKey: string; readonly prefix: string }[];
    readonly output: Extract<ExperimentOutputSelector, { kind: 'workflow-artifact' }> }
)
export interface ExperimentVariant {
  readonly variantKey: string
  readonly recipe: HostConfig
  readonly bindings: readonly ExperimentBinding[]
  readonly factors: JsonObject
  readonly fixture: { readonly kind: 'builtin' } | { readonly kind: 'programmatic'; readonly fixtureKey: string; readonly version: string; readonly sourceSha256: string }
}
export interface ExperimentLimits {
  readonly maxCases: number
  readonly maxVariants: number
  readonly maxUnits: number
  readonly maxInputBytes: number
  readonly maxPlanBytes: number
  readonly maxRecipeBytes: number
  readonly maxSessionCount: number
  readonly maxEvents: number
  readonly maxEvidenceBytes: number
  readonly maxMetricSamples: number
  readonly maxReportBytes: number
  readonly maxFixtureEntries: number
  readonly maxFixtureBytes: number
}
export interface ExperimentRunPolicy {
  readonly mode: 'fixture' | 'live'
  readonly maxDriveCalls: number
  readonly maxWallTimeMs: number
  readonly onCaseFailure: 'continue' | 'stop'
}
export interface ExperimentDefinition {
  readonly version: 1
  readonly experimentKey: string
  readonly dataset: { readonly datasetKey: string; readonly version: string; readonly cases: readonly ExperimentCase[] }
  readonly variants: readonly ExperimentVariant[]
  readonly comparisons: readonly { readonly comparisonKey: string; readonly variantA: string; readonly variantB: string }[]
  readonly repetitions: number
  readonly order: 'declared' | 'alternating-pairs'
  readonly evaluators: readonly ExperimentEvaluator[]
  readonly runPolicy: ExperimentRunPolicy
  readonly storage: { readonly controlRoot: string; readonly workspaceRoot: string; readonly maxRecordBytes: number }
  readonly evidenceLimits: ExperimentLimits
  readonly provenance: JsonObject
}
/** Frozen material bytes represented losslessly by validated UTF-8 text. */
export interface FrozenExperimentMaterial {
  readonly logicalPath: string
  readonly mediaType: ExperimentMediaType
  readonly text: string
  readonly byteLength: number
  readonly sha256: string
}
export interface FrozenExperimentCase extends Omit<ExperimentCase, 'materials'> {
  readonly materials: readonly FrozenExperimentMaterial[]
  readonly caseDigest: string
  readonly evaluatorDigest: string
}
/** One preallocated observation; recipe is the exact resolved Host input. */
export interface ExperimentUnit {
  readonly unitKey: string
  readonly caseKey: string
  readonly variantKey: string
  readonly repetition: number
  readonly ordinal: number
  readonly hostRoot: string
  readonly workspaceRoot: string
  readonly config: HostConfig
  readonly recipe: ResolvedHostSpec
  readonly recipeDigest: string
  readonly comparisonFingerprint: string
  readonly entry: ExperimentBinding
}
export interface ExperimentPlan extends Omit<ExperimentDefinition, 'dataset'> {
  readonly experimentId: SessionAddress
  readonly journalSessionId: SessionId
  readonly dataset: { readonly datasetKey: string; readonly version: string; readonly cases: readonly FrozenExperimentCase[]; readonly datasetDigest: string }
  readonly units: readonly ExperimentUnit[]
  readonly planDigest: string
}
/** Bootstrap fields sufficient to read the experiment without any Host assembly. */
export interface ExperimentLocation {
  readonly version: 1
  readonly controlRoot: string
  readonly journalSessionId: SessionId
  readonly maxRecordBytes: number
  readonly planDigest: string
}
/** Create-only file reference; path is relative to the experiment control root. */
export interface ExperimentFileRef extends JsonObject {
  readonly path: string
  readonly sha256: string
  readonly byteLength: number
}

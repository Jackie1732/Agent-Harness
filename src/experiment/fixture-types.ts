import type { ModelOutputBlock, ModelRequest, ModelStopReason, ModelStreamLimits, NormalizedModelResult } from '../model/contract.js'
import type { ModelInvocationId } from '../model/ids.js'
import type { ScriptedModelProvider } from '../model/providers/scripted.js'
import type { SessionSnapshot } from '../session/types.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import type { ExperimentLimits } from './definition-types.js'
import type { EvidenceSessionCut } from './evidence-types.js'
import type { ExperimentOutcome } from './journal-types.js'

export type NormalizedCallFixtureLimits = Pick<ExperimentLimits, 'maxFixtureBytes' | 'maxFixtureEntries'>

export interface NormalizedCallFixtureResult extends Omit<NormalizedModelResult, 'blocks' | 'protocolComplete' | 'stopReason'> {
  readonly blocks: readonly (Extract<ModelOutputBlock, { kind: 'text' }> & { readonly complete: true })[]
  readonly protocolComplete: true
  readonly stopReason: Exclude<ModelStopReason, 'tool-calls' | 'length'>
}

/** Original canonical result and request; these records do not contain transport frames. */
export interface NormalizedCallFixtureEntry {
  readonly invocationId: ModelInvocationId
  readonly prepared: WorkflowEventRef
  readonly started: WorkflowEventRef
  readonly settled: WorkflowEventRef
  readonly preparedFingerprint: string
  readonly request: ModelRequest
  readonly result: NormalizedCallFixtureResult
  readonly resultSha256: string
}

/** The committed source cut is separate from canonical result digests. */
export interface NormalizedCallFixture {
  readonly format: 'normalized-call-fixture/v1'
  readonly exporterVersion: '1'
  readonly source: EvidenceSessionCut
  readonly entries: readonly NormalizedCallFixtureEntry[]
}

export interface ExportNormalizedCallFixtureInput {
  readonly snapshot: SessionSnapshot
  /** Supplied by the raw-byte evidence Reader for this exact snapshot. */
  readonly source: EvidenceSessionCut
  readonly invocationIds: readonly ModelInvocationId[]
  readonly limits: NormalizedCallFixtureLimits
}

export type NormalizedCallFixtureExport = { readonly status: 'supported'; readonly fixture: NormalizedCallFixture }
  | { readonly status: 'unsupported'; readonly invocationId: ModelInvocationId;
    readonly reason: 'invocation-not-found' | 'invocation-unsettled' | 'non-successful-call' | 'request-profile' | 'request-continuation' | 'non-text-output' }

export interface NormalizedCallFixtureConsumption {
  readonly total: number
  readonly consumed: number
  readonly remaining: readonly ModelInvocationId[]
}

export interface NormalizedCallFixtureReplayOptions {
  readonly fixture: NormalizedCallFixture
  readonly providerId: string
  readonly streamLimits: ModelStreamLimits
}

/** One Provider for one independent serial SessionModelRunner; the caller owns disposal. */
export interface NormalizedCallFixtureReplay {
  readonly provider: ScriptedModelProvider
  snapshot(): NormalizedCallFixtureConsumption
  /** Successful declarations must consume the entire script; other outcomes retain remaining. */
  finish(outcome: ExperimentOutcome): NormalizedCallFixtureConsumption
}

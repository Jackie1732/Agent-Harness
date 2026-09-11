import { HarnessError } from '../foundation/error.js'
import type { HarnessErrorOptions, JsonObject } from '../index.js'

/** Stable error codes reported by the Step 1 effect lifecycle kernel. */
export type EffectErrorCode =
  | 'EFFECT_OWNER_INACTIVE'
  | 'EFFECT_START_INTERRUPTED'
  | 'EFFECT_ROLLBACK_FAILED'
  | 'EFFECT_DISPOSAL_FAILED'
  | 'EFFECT_REENTRANT_DISPOSE'

/**
 * Stage of one cleanup attempt that produced a failure.
 *
 * `revert` is the stage a failing inverse reports and the only one the current release
 * paths emit. `wait` is reported by the defence that keeps a release from joining cleanup
 * already owned by an active release in the same asynchronous chain; the release guards
 * reject that request before it reaches the record, so no current test reaches this stage.
 */
export type CleanupFailureStage = 'revert' | 'wait'

/** One cleanup attempt that failed, in the order the attempt was made. */
export interface EffectCleanupFailure {
  /** Label of the operation whose cleanup failed, absent for a record without one. */
  readonly operationLabel?: string
  /** Cleanup stage that failed. */
  readonly stage: CleanupFailureStage
  /** Original reason, preserved for programmatic inspection. */
  readonly reason: unknown
}

/** Which ownership scope requested a release. */
export type EffectDisposalTarget = 'lease' | 'owner'

/** Options accepted by every effect lifecycle error. */
export interface EffectErrorOptions extends HarnessErrorOptions {
  /** Labels of the ownership scopes involved, most specific first. */
  readonly labels?: readonly string[]
}

/**
 * Read a stable diagnostic name from an arbitrary failure reason.
 *
 * @param reason - Value thrown or rejected by user code.
 * @returns A stable name suitable for JSON diagnostics.
 */
export function describeReasonName(reason: unknown): string {
  if (reason instanceof Error) return reason.name
  if (reason === null) return 'null'
  return typeof reason
}

/**
 * Project cleanup failures to stable, JSON-safe diagnostics.
 *
 * The projection carries labels, stages and failure counts. It deliberately omits
 * free-form failure messages and any field that would assert a completed recovery.
 *
 * @param failures - Failures in the order the cleanup attempts were made.
 * @returns JSON-safe projections in the same order.
 */
export function projectCleanupFailures(
  failures: readonly EffectCleanupFailure[],
): readonly JsonObject[] {
  return failures.map(failure => ({
    ...(failure.operationLabel === undefined ? {} : { operationLabel: failure.operationLabel }),
    stage: failure.stage,
    reasonName: describeReasonName(failure.reason),
  }))
}

function describeCleanupCounts(failures: readonly EffectCleanupFailure[]): string {
  return `attempted ${failures.length} cleanup ${failures.length === 1 ? 'inverse' : 'inverses'}, `
    + `${failures.length} failed`
}

/** The Owner or Effect no longer accepts new work. */
export class EffectOwnerInactiveError extends HarnessError<'EFFECT_OWNER_INACTIVE'> {
  /** Label of the Effect or operation that requested the rejected work. */
  readonly requestLabel: string
  /** Lifecycle status at the moment the request was rejected. */
  readonly ownerStatus: string

  /**
   * Create the error for work requested from a releasing Owner or Effect.
   *
   * @param requestLabel - Label of the Effect or operation that requested work.
   * @param ownerStatus - Lifecycle status at the moment the request was rejected.
   */
  constructor(requestLabel: string, ownerStatus: string) {
    const target = ownerStatus === 'effect-released' ? 'effect' : 'owner'
    super(
      'EFFECT_OWNER_INACTIVE',
      `${target} rejected "${requestLabel}" because its status is "${ownerStatus}"`,
      { details: { requestLabel, ownerStatus } },
    )
    this.name = 'EffectOwnerInactiveError'
    this.requestLabel = requestLabel
    this.ownerStatus = ownerStatus
  }
}

/**
 * Setup completed after its owner requested release, so the Effect rolled back instead.
 */
export class EffectStartInterruptedError extends HarnessError<'EFFECT_START_INTERRUPTED'> {
  /** Label of the interrupted Effect. */
  readonly effectLabel: string
  /** Number of cleanup inverses the local rollback claimed. */
  readonly attempted: number
  /** Number of cleanup inverses that failed during the rollback. */
  readonly failed: number

  /**
   * Create the error for an Effect that setup completed but the owner had released.
   *
   * @param effectLabel - Label of the interrupted Effect.
   * @param attempted - Number of cleanup inverses the local rollback claimed.
   * @param failures - Failed subset of those attempts, in attempt order.
   */
  constructor(
    effectLabel: string,
    attempted: number,
    failures: readonly EffectCleanupFailure[],
  ) {
    super(
      'EFFECT_START_INTERRUPTED',
      `effect "${effectLabel}" was interrupted after setup succeeded; `
        + `${attempted} cleanup ${attempted === 1 ? 'inverse' : 'inverses'} attempted, `
        + `${failures.length} failed`,
      { details: { effectLabel, attempted, failedCount: failures.length, failures: projectCleanupFailures(failures) } },
    )
    this.name = 'EffectStartInterruptedError'
    this.effectLabel = effectLabel
    this.attempted = attempted
    this.failed = failures.length
  }
}

/** An Effect could not start and one or more of its accepted inverses also failed. */
export class EffectRollbackFailedError extends HarnessError<'EFFECT_ROLLBACK_FAILED'> {
  /** Label of the Effect whose rollback failed. */
  readonly effectLabel: string
  /** Setup failure, or the startup interruption when setup itself succeeded. */
  readonly setupReason: unknown
  /** Cleanup failures in the order the attempts were made. */
  readonly cleanupFailures: readonly EffectCleanupFailure[]

  /**
   * Create the combined error for an unsuccessful startup and failed rollback.
   *
   * @param effectLabel - Label of the Effect whose rollback failed.
   * @param setupReason - Setup failure, or the interruption when setup itself succeeded.
   * @param cause - Reason the startup ended.
   * @param cleanupFailures - Cleanup failures in attempt order.
   */
  constructor(
    effectLabel: string,
    setupReason: unknown,
    cause: unknown,
    cleanupFailures: readonly EffectCleanupFailure[],
  ) {
    super(
      'EFFECT_ROLLBACK_FAILED',
      `effect "${effectLabel}" failed during startup and its rollback is incomplete; `
        + `${describeCleanupCounts(cleanupFailures)}`,
      { cause, details: { effectLabel, ...cleanupFailureDetails(cleanupFailures) } },
    )
    this.name = 'EffectRollbackFailedError'
    this.effectLabel = effectLabel
    this.setupReason = setupReason
    this.cleanupFailures = cleanupFailures
  }
}

/**
 * A Lease or Owner release observed one or more failed cleanup inverses.
 */
export class EffectDisposalFailedError extends HarnessError<'EFFECT_DISPOSAL_FAILED'> {
  /** Ownership scope that requested the release. */
  readonly target: EffectDisposalTarget
  /** Label of the released Effect, absent for an owner-wide release. */
  readonly effectLabel?: string
  /** Cleanup failures in the order the attempts were made. */
  readonly cleanupFailures: readonly EffectCleanupFailure[]

  /**
   * Create the error for a release whose cleanup is incomplete.
   *
   * @param target - Ownership scope that requested the release.
   * @param effectLabel - Label of the released Effect, absent for an owner-wide release.
   * @param cleanupFailures - Cleanup failures in attempt order.
   */
  constructor(
    target: EffectDisposalTarget,
    effectLabel: string | undefined,
    cleanupFailures: readonly EffectCleanupFailure[],
  ) {
    const scope = target === 'lease' ? `lease "${effectLabel ?? 'unknown'}"` : 'owner'
    super(
      'EFFECT_DISPOSAL_FAILED',
      `${scope} release is incomplete; ${describeCleanupCounts(cleanupFailures)}`,
      {
        details: {
          target,
          ...(effectLabel === undefined ? {} : { effectLabel }),
          ...cleanupFailureDetails(cleanupFailures),
        },
      },
    )
    this.name = 'EffectDisposalFailedError'
    this.target = target
    if (effectLabel !== undefined) this.effectLabel = effectLabel
    this.cleanupFailures = cleanupFailures
  }
}

/**
 * A release call reached a target whose release task is already active in the current
 * asynchronous chain, which would make the caller wait for itself.
 */
export class EffectReentrantDisposeError extends HarnessError<'EFFECT_REENTRANT_DISPOSE'> {
  /** Labels of the ownership scopes involved, most specific first. */
  readonly labels: readonly string[]

  /**
   * Create the error for a release that would wait for its own task.
   *
   * @param labels - Labels of the ownership scopes involved, most specific first.
   */
  constructor(labels: readonly string[]) {
    super(
      'EFFECT_REENTRANT_DISPOSE',
      `release of ${labels.map(label => `"${label}"`).join(' inside ')} re-entered its own `
        + 'cleanup task and would wait for itself',
      { details: { labels: [...labels] } },
    )
    this.name = 'EffectReentrantDisposeError'
    this.labels = labels
  }
}

function cleanupFailureDetails(
  failures: readonly EffectCleanupFailure[],
): { failedCount: number; failures: readonly JsonObject[] } {
  return { failedCount: failures.length, failures: projectCleanupFailures(failures) }
}

import { EffectOwner } from '../effect/index.js'
import type { EffectContext } from '../effect/index.js'
import type { ScopeControl } from '../extension/scope-tree.js'
import type { Scope } from '../extension/types.js'
import { HarnessError } from '../foundation/error.js'
import type { JsonObject } from '../foundation/json.js'
import {
  CapabilityBindingInvalidError,
  CapabilityKeyUndeclaredError,
  CapabilityProviderConflictError,
  CapabilityUnsatisfiedError,
  ComponentInactiveError,
} from './errors.js'
import type { ComponentDeclaration } from './evaluate.js'
import type {
  CapabilityKey,
  ComponentContext,
  ComponentDefinition,
  ComponentHandle,
  ComponentId,
  ComponentStatus,
  FailurePhase,
  ProviderBinding,
  ProviderInstance,
  ProviderInstanceId,
} from './types.js'

/** Mutable record of one mounted component. */
export interface ComponentRecord {
  readonly id: ComponentId
  readonly label: string
  readonly ordinal: number
  readonly requires: readonly CapabilityKey<unknown>[]
  readonly provides: readonly CapabilityKey<unknown>[]
  readonly setup: (context: ComponentContext) => Promise<void>
  status: ComponentStatus
  releasing: boolean
  /**
   * Resolution this component is bound to for its current episode.
   *
   * While activating it is the view captured when the attempt started, which keeps the
   * running setup reading one stable resolution. Once the bindings publish it is that
   * captured view restricted to declared requirements, so a consumer's committed view
   * names the provider instance for each dependency.
   */
  committed: Map<CapabilityKey<unknown>, ProviderInstance>
  /** Resolution captured when the running activation started, used for drift checks. */
  attemptView: Map<CapabilityKey<unknown>, ProviderInstance> | undefined
  /** Values offered by the running activation; cleared when it settles. */
  staged: Map<CapabilityKey<unknown>, unknown> | undefined
  /** Effect owner of the current activation. */
  owner: EffectOwner | undefined
  /** Scope owned by the current activation attempt or committed episode. */
  activationScope: ScopeControl | undefined
  /** Number of resource inverses accepted by the current activation. */
  cleanupCount: number
  /** Successful publication count used to allocate a fresh provider identity. */
  providerSequence: number
  /** Why the running activation was interrupted by a later registry mutation. */
  interruption: 'release' | 'dependency' | undefined
  /** Phase of the latest failure; retained in a terminal state when cleanup is incomplete. */
  failurePhase: FailurePhase | undefined
  /** Raw reason of the latest failure; retained in a terminal state when cleanup is incomplete. */
  failure: unknown
  /** Whether the latest failure left the component safe to activate again. */
  retryable: boolean
  /** Registry sequence assigned when the latest incomplete cleanup was observed. */
  failureSequence: number | undefined
  /** Set while a transition task owns this component. */
  busy: boolean
  /** Shared task created by the first explicit release request. */
  releaseTask: Promise<void> | undefined
  /** Shared task created by concurrent retries of one failed episode. */
  retryTask: Promise<void> | undefined
}

/** One activation's captured inputs. */
export interface ActivationAttempt {
  /** Effect owner created for this attempt. */
  readonly owner: EffectOwner
  /** Root Effect context that owns this activation's operations. */
  effect: EffectContext | undefined
  /** Resolution captured when the attempt started. */
  readonly view: Map<CapabilityKey<unknown>, ProviderInstance>
  /** Values offered through `provide()`, published only when the activation commits. */
  readonly staged: Map<CapabilityKey<unknown>, unknown>
  /** Staged extension scope published with this activation's bindings. */
  readonly scope: ScopeControl
  /**
   * Signal of the activation root effect.
   *
   * It is captured when the activation starts, which happens before `setup` runs; the
   * context therefore publishes it as defined for every read `setup` can make.
   */
  signal: AbortSignal | undefined
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Capability access and effect acquisition for one activation.
 *
 * The context is valid only while `setup` runs. Reading a key returns the value from the
 * attempt view captured at activation start, so a provider retiring mid-setup does not
 * change what this activation observes.
 */
export class ActivationContext implements ComponentContext {
  readonly #record: ComponentRecord
  readonly #attempt: ActivationAttempt
  readonly #onProvide: (key: CapabilityKey<unknown>, value: unknown) => void
  #open = true

  /**
   * Create the context of one activation.
   *
   * @param record - Component this activation belongs to.
   * @param attempt - Captured owner, view, and staging area.
   * @param onProvide - Callback recording each offered binding.
   */
  constructor(
    record: ComponentRecord,
    attempt: ActivationAttempt,
    onProvide: (key: CapabilityKey<unknown>, value: unknown) => void,
  ) {
    this.#record = record
    this.#attempt = attempt
    this.#onProvide = onProvide
  }

  /**
   * Aborted once the owning activation stops.
   *
   * Reading it outside `setup` is a programming error: the context has already closed by
   * then and the accessor reports that state.
   */
  get signal(): AbortSignal {
    this.#assertOpen('signal')
    const signal = this.#attempt.signal
    if (signal === undefined) {
      throw new ComponentInactiveError('not-started', 'signal', this.#record.label)
    }
    return signal
  }

  /** Scope whose contributions publish only if this activation commits. */
  get scope(): Scope {
    this.#assertOpen('scope')
    return this.#attempt.scope.scope
  }

  /**
   * Acquire a revertible resource inside this activation.
   *
   * @param label - Diagnostic label of the operation.
   * @param operation - Forward operation producing the value.
   * @param revert - Inverse applied to the produced value during cleanup.
   * @returns The value produced by `operation`.
   */
  async apply<T>(
    label: string,
    operation: () => T | PromiseLike<T>,
    revert: (value: T) => void | PromiseLike<void>,
  ): Promise<T> {
    this.#assertOpen('apply')
    const effect = this.#attempt.effect
    if (effect === undefined) {
      throw new ComponentInactiveError('not-started', 'apply()', this.#record.label)
    }
    const value = await effect.apply(label, operation, revert)
    this.#record.cleanupCount += 1
    return value
  }

  /**
   * Read a declared requirement from this activation's view.
   *
   * @param key - Key declared in `requires`.
   * @returns The value currently bound at that key.
   */
  require<T>(key: CapabilityKey<T>): T {
    this.#assertOpen('require')
    if (!this.#record.requires.includes(key)) {
      throw new CapabilityKeyUndeclaredError(this.#record.label, key.name, 'require')
    }
    const instance = this.#attempt.view.get(key)
    const binding = instance?.bindings.find(candidate => candidate.key === key)
    if (binding === undefined) {
      throw new CapabilityUnsatisfiedError(this.#record.label, [key.name])
    }
    return binding.value as T
  }

  /**
   * Offer the value of a declared key; it publishes only if this activation commits.
   *
   * @param key - Key declared in `provides`.
   * @param value - Value to publish under that key.
   */
  provide<T>(key: CapabilityKey<T>, value: T): void {
    this.#assertOpen('provide')
    if (!this.#record.provides.includes(key)) {
      throw new CapabilityKeyUndeclaredError(this.#record.label, key.name, 'provide')
    }
    this.#onProvide(key, value)
  }

  /** Invalidate this context once its activation settled. */
  close(): void {
    this.#open = false
  }

  #assertOpen(operation: string): void {
    if (!this.#open) {
      throw new ComponentInactiveError('settled', `${operation}()`, this.#record.label)
    }
  }
}

/**
 * Validate the staged bindings of one activation without publishing them.
 *
 * @param record - Component whose activation is committing.
 * @param staged - Values offered through `provide()`.
 * @returns The provider instance that can be published without more validation.
 */
export function prepareBindings(
  record: ComponentRecord,
  staged: ReadonlyMap<CapabilityKey<unknown>, unknown>,
): ProviderInstance {
  for (const key of staged.keys()) {
    if (!record.provides.includes(key)) {
      throw new CapabilityBindingInvalidError(record.label, key.name, 'undeclared')
    }
  }

  const bindings: ProviderBinding[] = []
  for (const key of record.provides) {
    if (!staged.has(key)) {
      throw new CapabilityBindingInvalidError(record.label, key.name, 'missing')
    }
    bindings.push({ key, value: staged.get(key) })
  }

  const instance: ProviderInstance = {
    id: `${record.id}#${record.providerSequence + 1}` as ProviderInstanceId,
    component: record.id,
    bindings,
  }
  return instance
}

/**
 * Publish a provider instance that already passed activation validation.
 *
 * @param instance - Prepared provider instance.
 * @param activeBindings - Registry binding view to extend.
 */
export function publishBindings(
  instance: ProviderInstance,
  activeBindings: Map<CapabilityKey<unknown>, ProviderInstance>,
): void {
  for (const binding of instance.bindings) activeBindings.set(binding.key, instance)
}

/**
 * Find the component that reserves a key, considering only components that can still
 * offer it.
 *
 * @param key - Key to look up.
 * @param components - Every mounted component.
 * @returns The claiming record, or undefined when the key is unclaimed.
 */
export function findClaimant(
  key: CapabilityKey<unknown>,
  components: Iterable<ComponentRecord>,
): ComponentRecord | undefined {
  for (const record of components) {
    if (record.status === 'disposed') continue
    if (record.provides.includes(key)) return record
  }
  return undefined
}

/**
 * Reject a claim for a key that another component already reserves.
 *
 * @param record - Component requesting the key.
 * @param key - Contested key.
 * @param components - Every mounted component.
 * @throws {CapabilityProviderConflictError} If another component holds the claim.
 */
export function assertClaimAvailable(
  record: ComponentRecord,
  key: CapabilityKey<unknown>,
  components: Iterable<ComponentRecord>,
): void {
  const claimant = findClaimant(key, components)
  if (claimant !== undefined && claimant.id !== record.id) {
    const retiring = claimant.releasing || claimant.status === 'deactivating'
    throw new CapabilityProviderConflictError(
      key.name,
      claimant.label,
      record.label,
      retiring,
      claimant.id,
      record.id,
    )
  }
}

/**
 * Project a mounted component into the declaration the evaluator consumes.
 *
 * @param record - Component to project.
 * @returns Its immutable declaration.
 */
export function toDeclaration(record: ComponentRecord): ComponentDeclaration {
  return {
    id: record.id,
    label: record.label,
    ordinal: record.ordinal,
    requires: record.requires,
    provides: record.provides,
    releasing: record.releasing,
    status: record.status,
    committed: record.status === 'activating' && record.attemptView !== undefined
      ? record.attemptView
      : record.committed,
  }
}

/**
 * Describe a failure reason for a JSON-safe snapshot.
 *
 * @param reason - Value thrown by user code.
 * @returns A stable projection with JSON-safe fields and bounded causes.
 */
export function projectFailure(reason: unknown): JsonObject {
  if (reason instanceof HarnessError) return { ...reason.toJSON() }
  return {
    name: reason instanceof Error ? reason.name : typeof reason,
    message: messageOf(reason),
  }
}

/**
 * Create a component handle bound to one registry record.
 *
 * @param record - Component the handle exposes.
 * @param retry - Retry action owned by the registry.
 * @param dispose - Release action owned by the registry.
 * @returns The handle.
 */
export function createHandle(
  record: ComponentRecord,
  retry: () => Promise<void>,
  dispose: () => Promise<void>,
): ComponentHandle {
  const handle: ComponentHandle = {
    id: record.id,
    label: record.label,
    get status(): ComponentStatus {
      return record.status
    },
    get error(): unknown {
      return record.failure
    },
    retry,
    dispose,
  }
  return handle
}

export type { ComponentDefinition }

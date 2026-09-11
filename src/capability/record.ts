import { EffectOwner } from '../effect/index.js'
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

/** Inverses of the bindings one activation published, applied when it withdraws. */
export type ProviderTeardown = () => Promise<void>

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
   * captured view extended with the instance this activation published, so a consumer's
   * committed view names its dependencies rather than only its own offerings.
   */
  committed: Map<CapabilityKey<unknown>, ProviderInstance>
  /** Resolution captured when the running activation started, used for drift checks. */
  attemptView: Map<CapabilityKey<unknown>, ProviderInstance> | undefined
  /** Values offered by the running activation; cleared when it settles. */
  staged: Map<CapabilityKey<unknown>, unknown> | undefined
  /** Inverses of the bindings this component published, applied when it withdraws. */
  teardown: ProviderTeardown | undefined
  /** Effect owner of the current activation. */
  owner: EffectOwner | undefined
  /** Phase of the latest failure, cleared when a transition succeeds. */
  failurePhase: FailurePhase | undefined
  /** Raw reason of the latest failure, cleared when a transition succeeds. */
  failure: unknown
  /** Set while a transition task owns this component. */
  busy: boolean
}

/** One activation's captured inputs. */
export interface ActivationAttempt {
  /** Effect owner created for this attempt. */
  readonly owner: EffectOwner
  /** Resolution captured when the attempt started. */
  readonly view: Map<CapabilityKey<unknown>, ProviderInstance>
  /** Values offered through `provide()`, published only when the activation commits. */
  readonly staged: Map<CapabilityKey<unknown>, unknown>
  /** Signal of the activation root effect, captured when the activation started. */
  signal: AbortSignal
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

  /** Aborted once the owning activation stops. */
  get signal(): AbortSignal {
    return this.#attempt.signal
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
    const lease = await this.#attempt.owner.run(
      label,
      effect => effect.apply(label, operation, revert),
    )
    return lease.value
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
 * Validate and publish the staged bindings of one activation.
 *
 * The whole batch becomes visible in one synchronous section, so a consumer never
 * observes a partially published activation.
 *
 * @param record - Component whose activation is committing.
 * @param staged - Values offered through `provide()`.
 * @param activeBindings - Registry binding view to extend.
 * @returns The published provider instance and the resolution it establishes.
 */
export function publishBindings(
  record: ComponentRecord,
  staged: ReadonlyMap<CapabilityKey<unknown>, unknown>,
  activeBindings: Map<CapabilityKey<unknown>, ProviderInstance>,
): { readonly instance: ProviderInstance; readonly view: Map<CapabilityKey<unknown>, ProviderInstance> } {
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
    id: `${record.id}#${record.ordinal}:${staged.size}` as ProviderInstanceId,
    component: record.id,
    bindings,
  }

  const view = new Map<CapabilityKey<unknown>, ProviderInstance>()
  for (const binding of bindings) {
    activeBindings.set(binding.key, instance)
    view.set(binding.key, instance)
  }

  return { instance, view }
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
    throw new CapabilityProviderConflictError(key.name, claimant.label, record.label, retiring)
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
    committed: record.committed,
  }
}

/**
 * Describe a failure reason for a JSON-safe snapshot.
 *
 * @param reason - Value thrown by user code.
 * @returns A stable projection carrying no free-form payload.
 */
export function projectFailure(reason: unknown): { readonly message: string; readonly name: string } {
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

import type { Brand } from '../foundation/brand.js'
import type { JsonObject } from '../foundation/json.js'
import type { Awaitable, EffectContext } from '../effect/index.js'

declare const capabilityValue: unique symbol

/** Compile-time value type carried by a capability key. */
export interface CapabilityKey<T> {
  /** Name used in diagnostics and conflict messages; never an identity. */
  readonly name: string
  /**
   * Compile-time-only marker; absent at runtime.
   *
   * The marker is deliberately not callable: a function-typed marker would make `T`
   * contravariant and stop a key from being usable where `CapabilityKey<unknown>` is
   * expected, which every declaration list needs.
   */
  readonly [capabilityValue]?: { readonly value?: T }
}

/** Registry-local identity of one mounted component. */
export type ComponentId = Brand<string, 'ComponentId'>

/** Registry-local identity of one provider instance. */
export type ProviderInstanceId = Brand<string, 'ProviderInstanceId'>

/** Lifecycle state of one mounted component. */
export type ComponentStatus =
  | 'unsatisfied'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'failed'
  | 'disposed'

/** Which transition failed for a component in the `failed` status. */
export type FailurePhase = 'activation' | 'deactivation'

/** Registry lifecycle state. */
export type RegistryStatus = 'accepting' | 'disposing' | 'disposed'

/** One binding published by a provider instance. */
export interface ProviderBinding {
  /** Key the binding resolves. */
  readonly key: CapabilityKey<unknown>
  /** Published value held by the runtime. */
  readonly value: unknown
}

/** One published provider instance: the batch of bindings of a single activation. */
export interface ProviderInstance {
  /** Identity of this activation's batch. */
  readonly id: ProviderInstanceId
  /** Component whose activation published the batch. */
  readonly component: ComponentId
  /** Bindings in declaration order. */
  readonly bindings: readonly ProviderBinding[]
}

/** A component declares what it needs and what it offers. */
export interface ComponentDefinition {
  /** Diagnostic label; may repeat across components. */
  readonly label: string
  /** Required capability keys; never empty-checked and never mutated after mount. */
  readonly requires: readonly CapabilityKey<unknown>[]
  /** Offered capability keys; ownership is reserved at mount. */
  readonly provides: readonly CapabilityKey<unknown>[]
  /**
   * Runs once the requirements are satisfied.
   *
   * @param context - Capability access and effect acquisition for this activation.
   */
  readonly setup: (context: ComponentContext) => Awaitable<void>
}

/**
 * Execution context of one activation.
 *
 * It is valid only while `setup` runs. Reading or providing after `setup` settles
 * reports `COMPONENT_INACTIVE` instead of returning a possibly stale binding.
 */
export interface ComponentContext extends EffectContext {
  /**
   * Read a declared requirement from the attempt view captured for this activation.
   *
   * @param key - Key declared in `requires`.
   * @returns The bound value.
   */
  require<T>(key: CapabilityKey<T>): T

  /**
   * Offer the value for a declared key; published only if the whole activation commits.
   *
   * @param key - Key declared in `provides`.
   * @param value - Value to publish under that key.
   */
  provide<T>(key: CapabilityKey<T>, value: T): void
}

/** Handle for one mounted component. */
export interface ComponentHandle {
  /** Registry-local identity. */
  readonly id: ComponentId
  /** Diagnostic label copied from the definition. */
  readonly label: string
  /** Current lifecycle state. */
  readonly status: ComponentStatus

  /**
   * Raw reason of the most recent failure, present only while `status` is `failed`.
   *
   * The value is left untransformed for programmatic inspection; the JSON-safe
   * projection of the same failure appears in the registry snapshot.
   */
  readonly error?: unknown

  /**
   * Retry a failed component.
   *
   * @returns A promise that settles after the retry attempt finishes.
   */
  retry(): Promise<void>

  /**
   * Release this component and wait for its cleanup to settle.
   *
   * @returns A promise that settles when the component reaches a terminal state.
   */
  dispose(): Promise<void>
}

/** JSON-safe projection of one component in a snapshot. */
export interface ComponentSnapshot {
  /** Registry-local identity. */
  readonly id: string
  /** Diagnostic label. */
  readonly label: string
  /** Current lifecycle state. */
  readonly status: ComponentStatus
  /** Failure phase when the component is failed. */
  readonly failurePhase?: FailurePhase
  /** Names of the keys this component declares as required. */
  readonly requires: readonly string[]
  /** Names of the keys this component declares as offered. */
  readonly provides: readonly string[]
  /** Key names this component currently resolves, with the provider instance identity. */
  readonly committed: Readonly<Record<string, string>>
  /** Transition currently running for this component, when any. */
  readonly task?: 'activation' | 'deactivation'
  /** JSON-safe projection of the latest failure. */
  readonly failure?: JsonObject
}

/** JSON-safe projection of one published provider instance. */
export interface ProviderSnapshot {
  /** Provider instance identity. */
  readonly id: string
  /** Component whose activation published this batch. */
  readonly component: string
  /** Key names bound by this instance. */
  readonly keys: readonly string[]
}

/** JSON-safe diagnostic view of a registry. */
export interface RegistrySnapshot {
  /** Reconciliation revision this snapshot describes. */
  readonly revision: number
  /** Component projections indexed by identity. */
  readonly components: readonly ComponentSnapshot[]
  /** Published provider instances. */
  readonly providers: readonly ProviderSnapshot[]
  /** Declared key names mapped to the components that declare them. */
  readonly declarations: Readonly<Record<string, readonly string[]>>
  /** Key names with no resolvable provider and the components waiting on them. */
  readonly unresolved: Readonly<Record<string, readonly string[]>>
}

import { HarnessError } from '../foundation/error.js'
import type { HarnessErrorOptions } from '../foundation/error.js'
import type { JsonObject } from '../foundation/json.js'

/** Stable error codes reported by the capability layer. */
export type CapabilityErrorCode =
  | 'CAPABILITY_KEY_NAME_CONFLICT'
  | 'CAPABILITY_KEY_UNDECLARED'
  | 'CAPABILITY_PROVIDER_CONFLICT'
  | 'CAPABILITY_BINDING_INVALID'
  | 'CAPABILITY_UNSATISFIED'
  | 'CAPABILITY_CYCLE'
  | 'COMPONENT_ACTIVATION_FAILED'
  | 'COMPONENT_DEACTIVATION_FAILED'
  | 'COMPONENT_RETRY_UNSATISFIED'
  | 'COMPONENT_INACTIVE'
  | 'REGISTRY_REENTRANT_WAIT'
  | 'REGISTRY_NOT_CONVERGED'

/** Labels of the components a diagnostic names. */
export interface CapabilityErrorOptions extends HarnessErrorOptions {
  /** Diagnostic labels, in the order the diagnostic names them. */
  readonly labels?: readonly string[]
}

function labelDetails(labels: readonly string[] | undefined): JsonObject {
  return labels === undefined ? {} : { labels: [...labels] }
}

/**
 * One registry received two different keys that share a diagnostic name.
 */
export class CapabilityKeyNameConflictError extends HarnessError<'CAPABILITY_KEY_NAME_CONFLICT'> {
  /** Name shared by the two keys. */
  readonly keyName: string
  /** Labels of the components that declared the keys. */
  readonly labels: readonly string[]
  /** Component identities of the conflicting declarations. */
  readonly componentIds: readonly string[]

  /**
   * Create the error for a duplicate diagnostic name inside one registry.
   *
   * @param keyName - Name shared by the two keys.
   * @param labels - Labels of the declaring components, in declaration order.
   * @param componentIds - Identities of the declaring components, in the same order.
   */
  constructor(keyName: string, labels: readonly string[] = [], componentIds: readonly string[] = []) {
    super(
      'CAPABILITY_KEY_NAME_CONFLICT',
      `capability name "${keyName}" is used by two different keys`
        + (labels.length === 0 ? '' : ` declared by ${labels.map(label => `"${label}"`).join(' and ')}`),
      { details: { keyName, ...labelDetails(labels), componentIds: [...componentIds] } },
    )
    this.name = 'CapabilityKeyNameConflictError'
    this.keyName = keyName
    this.labels = labels
    this.componentIds = componentIds
  }
}

/**
 * A component read or offered a key it did not declare.
 */
export class CapabilityKeyUndeclaredError extends HarnessError<'CAPABILITY_KEY_UNDECLARED'> {
  /** Label of the component that used the key. */
  readonly componentLabel: string
  /** Diagnostic name of the undeclared key. */
  readonly keyName: string
  /** Operation that used the key. */
  readonly operation: 'require' | 'provide'

  /**
   * Create the error for a key outside the component's declaration.
   *
   * @param componentLabel - Label of the component that used the key.
   * @param keyName - Diagnostic name of the undeclared key.
   * @param operation - Operation that used the key.
   */
  constructor(componentLabel: string, keyName: string, operation: 'require' | 'provide') {
    super(
      'CAPABILITY_KEY_UNDECLARED',
      `component "${componentLabel}" called ${operation}() for "${keyName}", which it does not declare`,
      { details: { componentLabel, keyName, operation } },
    )
    this.name = 'CapabilityKeyUndeclaredError'
    this.componentLabel = componentLabel
    this.keyName = keyName
    this.operation = operation
  }
}

/**
 * A key is already claimed by another component, or its previous provider is still retiring.
 */
export class CapabilityProviderConflictError extends HarnessError<'CAPABILITY_PROVIDER_CONFLICT'> {
  /** Diagnostic name of the contested key. */
  readonly keyName: string
  /** Label of the component that already holds the claim. */
  readonly heldBy: string
  /** Label of the component whose claim was rejected. */
  readonly requestedBy: string
  /** Whether the holder is still retiring rather than active. */
  readonly retiring: boolean
  /** Identity of the component that holds the claim. */
  readonly heldById?: string
  /** Identity of the component whose claim was rejected. */
  readonly requestedById?: string

  /**
   * Create the error for a rejected provider claim.
   *
   * @param keyName - Diagnostic name of the contested key.
   * @param heldBy - Label of the component that already holds the claim.
   * @param requestedBy - Label of the component whose claim was rejected.
   * @param retiring - Whether the holder is still retiring.
   * @param heldById - Identity of the component that holds the claim.
   * @param requestedById - Identity of the component whose claim was rejected.
   */
  constructor(
    keyName: string,
    heldBy: string,
    requestedBy: string,
    retiring: boolean,
    heldById?: string,
    requestedById?: string,
  ) {
    super(
      'CAPABILITY_PROVIDER_CONFLICT',
      `component "${requestedBy}" cannot provide "${keyName}" because "${heldBy}" already claims it`
        + (retiring ? ' and has not finished retiring' : ''),
      {
        details: {
          keyName,
          heldBy,
          requestedBy,
          retiring,
          ...(heldById === undefined ? {} : { heldById }),
          ...(requestedById === undefined ? {} : { requestedById }),
        },
      },
    )
    this.name = 'CapabilityProviderConflictError'
    this.keyName = keyName
    this.heldBy = heldBy
    this.requestedBy = requestedBy
    this.retiring = retiring
    if (heldById !== undefined) this.heldById = heldById
    if (requestedById !== undefined) this.requestedById = requestedById
  }
}

/**
 * An activation did not offer exactly one binding per declared key.
 */
export class CapabilityBindingInvalidError extends HarnessError<'CAPABILITY_BINDING_INVALID'> {
  /** Label of the component whose activation failed validation. */
  readonly componentLabel: string
  /** Diagnostic name of the key that failed validation. */
  readonly keyName: string
  /** What was wrong with the binding. */
  readonly problem: 'missing' | 'duplicate' | 'undeclared'

  /**
   * Create the error for an invalid binding set.
   *
   * @param componentLabel - Label of the component whose activation failed validation.
   * @param keyName - Diagnostic name of the offending key.
   * @param problem - What was wrong with the binding.
   */
  constructor(componentLabel: string, keyName: string, problem: 'missing' | 'duplicate' | 'undeclared') {
    super(
      'CAPABILITY_BINDING_INVALID',
      `component "${componentLabel}" failed to publish "${keyName}": binding is ${problem}`,
      { details: { componentLabel, keyName, problem } },
    )
    this.name = 'CapabilityBindingInvalidError'
    this.componentLabel = componentLabel
    this.keyName = keyName
    this.problem = problem
  }
}

/**
 * A component was asked to activate while its requirements are not satisfied.
 */
export class CapabilityUnsatisfiedError extends HarnessError<'CAPABILITY_UNSATISFIED'> {
  /** Label of the component that was asked to activate. */
  readonly componentLabel: string
  /** Diagnostic names of the keys with no resolvable provider. */
  readonly missingKeys: readonly string[]

  /**
   * Create the error for an activation request with unmet requirements.
   *
   * @param componentLabel - Label of the component.
   * @param missingKeys - Diagnostic names of the missing keys.
   */
  constructor(componentLabel: string, missingKeys: readonly string[]) {
    super(
      'CAPABILITY_UNSATISFIED',
      `component "${componentLabel}" cannot activate because `
        + `${missingKeys.map(key => `"${key}"`).join(', ')} ${missingKeys.length === 1 ? 'is' : 'are'} unresolved`,
      { details: { componentLabel, missingKeys: [...missingKeys] } },
    )
    this.name = 'CapabilityUnsatisfiedError'
    this.componentLabel = componentLabel
    this.missingKeys = missingKeys
  }
}

/**
 * The declaration graph contains a cycle, so the components on it can never activate.
 */
export class CapabilityCycleError extends HarnessError<'CAPABILITY_CYCLE'> {
  /** Diagnostic names of the keys that form the cycle, in path order. */
  readonly keyNames: readonly string[]
  /** Labels of the components on the cycle, in path order. */
  readonly labels: readonly string[]
  /** Component identities on the cycle, in path order. */
  readonly componentIds: readonly string[]

  /**
   * Create the error for a cyclic declaration graph.
   *
   * @param keyNames - Key names on the cycle, in path order.
   * @param labels - Component labels on the cycle, in path order.
   * @param componentIds - Component identities on the cycle, in path order.
   */
  constructor(
    keyNames: readonly string[],
    labels: readonly string[],
    componentIds: readonly string[] = [],
  ) {
    super(
      'CAPABILITY_CYCLE',
      `capability cycle over ${keyNames.map(key => `"${key}"`).join(' -> ')}`
        + ` involves ${labels.map(label => `"${label}"`).join(' -> ')}`,
      { details: { keyNames: [...keyNames], ...labelDetails(labels), componentIds: [...componentIds] } },
    )
    this.name = 'CapabilityCycleError'
    this.keyNames = keyNames
    this.labels = labels
    this.componentIds = componentIds
  }
}

/**
 * A component failed during activation; its effects were rolled back.
 */
export class ComponentActivationFailedError extends HarnessError<'COMPONENT_ACTIVATION_FAILED'> {
  /** Label of the failed component. */
  readonly componentLabel: string
  /** Original reason the activation failed. */
  readonly reason: unknown
  /** Number of accepted effect inverses the rollback claimed. */
  readonly rollbackAttempted: number

  /**
   * Create the error for a failed activation.
   *
   * @param componentLabel - Label of the failed component.
   * @param reason - Original reason the activation failed.
   * @param rollbackAttempted - Number of inverses the rollback claimed.
   */
  constructor(componentLabel: string, reason: unknown, rollbackAttempted: number) {
    super(
      'COMPONENT_ACTIVATION_FAILED',
      `component "${componentLabel}" failed during activation; `
        + `${rollbackAttempted} cleanup ${rollbackAttempted === 1 ? 'inverse' : 'inverses'} attempted`,
      { cause: reason, details: { componentLabel, rollbackAttempted } },
    )
    this.name = 'ComponentActivationFailedError'
    this.componentLabel = componentLabel
    this.reason = reason
    this.rollbackAttempted = rollbackAttempted
  }
}

/**
 * A component failed while deactivating, so it is closed rather than restarted.
 */
export class ComponentDeactivationFailedError extends HarnessError<'COMPONENT_DEACTIVATION_FAILED'> {
  /** Label of the component whose cleanup failed. */
  readonly componentLabel: string
  /** Number of cleanup inverses that were attempted. */
  readonly attempted: number
  /** Number of those attempts that failed. */
  readonly failed: number
  /** Original cleanup failure retained for programmatic inspection. */
  readonly reason: unknown

  /**
   * Create the error for a failed deactivation.
   *
   * @param componentLabel - Label of the component.
   * @param attempted - Number of cleanup inverses attempted.
   * @param failed - Number of attempts that failed.
   * @param reason - Original cleanup failure.
   */
  constructor(componentLabel: string, attempted: number, failed: number, reason?: unknown) {
    super(
      'COMPONENT_DEACTIVATION_FAILED',
      `component "${componentLabel}" failed while deactivating; ${attempted} cleanup `
        + `${attempted === 1 ? 'inverse' : 'inverses'} attempted, ${failed} failed`,
      { cause: reason, details: { componentLabel, attempted, failed } },
    )
    this.name = 'ComponentDeactivationFailedError'
    this.componentLabel = componentLabel
    this.attempted = attempted
    this.failed = failed
    this.reason = reason
  }
}

/**
 * A retry was requested while the component's requirements are not satisfied.
 */
export class ComponentRetryUnsatisfiedError extends HarnessError<'COMPONENT_RETRY_UNSATISFIED'> {
  /** Label of the component whose retry was rejected. */
  readonly componentLabel: string
  /** Diagnostic names of the keys with no resolvable provider. */
  readonly missingKeys: readonly string[]

  /**
   * Create the error for a rejected retry.
   *
   * @param componentLabel - Label of the component.
   * @param missingKeys - Diagnostic names of the missing keys.
   */
  constructor(componentLabel: string, missingKeys: readonly string[]) {
    super(
      'COMPONENT_RETRY_UNSATISFIED',
      `component "${componentLabel}" cannot retry because `
        + `${missingKeys.map(key => `"${key}"`).join(', ')} ${missingKeys.length === 1 ? 'is' : 'are'} unresolved`,
      { details: { componentLabel, missingKeys: [...missingKeys] } },
    )
    this.name = 'ComponentRetryUnsatisfiedError'
    this.componentLabel = componentLabel
    this.missingKeys = missingKeys
  }
}

/**
 * Work was requested from a released registry, a released component, or an expired context.
 */
export class ComponentInactiveError extends HarnessError<'COMPONENT_INACTIVE'> {
  /** Label of the component, absent for a registry-wide request. */
  readonly componentLabel?: string
  /** State that rejected the request. */
  readonly state: string
  /** What was requested. */
  readonly operation: string

  /**
   * Create the error for work requested from a closed or expired subject.
   *
   * @param state - State that rejected the request.
   * @param operation - What was requested.
   * @param componentLabel - Label of the component, absent for a registry-wide request.
   */
  constructor(state: string, operation: string, componentLabel?: string) {
    super(
      'COMPONENT_INACTIVE',
      `${componentLabel === undefined ? 'registry' : `component "${componentLabel}"`} in state `
        + `"${state}" rejected ${operation}`,
      {
        details: {
          state,
          operation,
          ...(componentLabel === undefined ? {} : { componentLabel }),
        },
      },
    )
    this.name = 'ComponentInactiveError'
    if (componentLabel !== undefined) this.componentLabel = componentLabel
    this.state = state
    this.operation = operation
  }
}

/**
 * Component lifecycle code waited for the reconciliation currently running it.
 */
export class RegistryReentrantWaitError extends HarnessError<'REGISTRY_REENTRANT_WAIT'> {
  /** Label of the component whose lifecycle callback waited. */
  readonly componentLabel: string
  /** Lifecycle phase that tried to wait for reconciliation. */
  readonly task: string

  /**
   * Create the error for lifecycle code that would wait for its own reconciliation.
   *
   * @param componentLabel - Label of the component whose lifecycle callback waited.
   * @param task - Task type the cleanup tried to wait for.
   */
  constructor(componentLabel: string, task: string) {
    super(
      'REGISTRY_REENTRANT_WAIT',
      `lifecycle callback of component "${componentLabel}" waited for the ${task} already running it`,
      { details: { componentLabel, task } },
    )
    this.name = 'RegistryReentrantWaitError'
    this.componentLabel = componentLabel
    this.task = task
  }
}

/**
 * The coordinator exhausted its step budget without the registry settling.
 */
export class RegistryNotConvergedError extends HarnessError<'REGISTRY_NOT_CONVERGED'> {
  /** Step budget the coordinator exhausted. */
  readonly maxSteps: number
  /** Per-component `label:status` projection at the point the guard tripped. */
  readonly statuses: readonly string[]

  /**
   * Create the error for a reconciliation that did not settle within its budget.
   *
   * @param maxSteps - Step budget the coordinator exhausted.
   * @param statuses - Per-component status projection at the guard trip.
   */
  constructor(maxSteps: number, statuses: readonly string[]) {
    super(
      'REGISTRY_NOT_CONVERGED',
      `reconciliation did not converge within ${maxSteps} steps: ${statuses.join(', ')}`,
      { details: { maxSteps, statuses: [...statuses] } },
    )
    this.name = 'RegistryNotConvergedError'
    this.maxSteps = maxSteps
    this.statuses = statuses
  }
}

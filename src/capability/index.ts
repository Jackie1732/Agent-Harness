export { createCapabilityKey } from './key.js'
export { CapabilityRegistry } from './registry.js'
export {
  CapabilityBindingInvalidError,
  CapabilityCycleError,
  CapabilityKeyNameConflictError,
  CapabilityKeyUndeclaredError,
  CapabilityProviderConflictError,
  ComponentActivationFailedError,
  ComponentDeactivationFailedError,
  ComponentInactiveError,
  ComponentRetryUnsatisfiedError,
  ComponentRetryUnsafeError,
  RegistryNotConvergedError,
  RegistryReentrantWaitError,
} from './errors.js'

export type { CapabilityErrorCode } from './errors.js'
export type {
  CapabilityKey,
  CapabilityCycleSnapshot,
  ComponentContext,
  ComponentDefinition,
  ComponentHandle,
  ComponentId,
  ComponentSnapshot,
  ComponentStatus,
  FailurePhase,
  ProviderSnapshot,
  RegistrySnapshot,
  RegistryStatus,
} from './types.js'

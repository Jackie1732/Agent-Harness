export { createCapabilityKey, capabilityKeyName } from './key.js'
export { detectCycles, evaluate } from './evaluate.js'
export { CapabilityRegistry } from './registry.js'
export {
  CapabilityBindingInvalidError,
  CapabilityCycleError,
  CapabilityKeyNameConflictError,
  CapabilityKeyUndeclaredError,
  CapabilityProviderConflictError,
  CapabilityUnsatisfiedError,
  ComponentActivationFailedError,
  ComponentDeactivationFailedError,
  ComponentInactiveError,
  ComponentRetryUnsatisfiedError,
  RegistryReentrantWaitError,
} from './errors.js'

export type { CapabilityErrorCode, CapabilityErrorOptions } from './errors.js'
export type {
  ChangeClassification,
  ComponentChange,
  ComponentDeclaration,
  CycleReport,
  EvaluationInput,
  EvaluationResult,
} from './evaluate.js'
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
  ProviderBinding,
  ProviderInstance,
  ProviderInstanceId,
  ProviderSnapshot,
  RegistrySnapshot,
  RegistryStatus,
} from './types.js'

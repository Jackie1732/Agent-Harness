import { EffectDisposalFailedError, EffectOwner } from '../effect/index.js'
import { ActivationContext, publishBindings } from './record.js'
import type { ActivationAttempt, ComponentRecord } from './record.js'
import {
  CapabilityBindingInvalidError,
  ComponentDeactivationFailedError,
} from './errors.js'
import type { CapabilityKey, ProviderInstance } from './types.js'

/** Mutable state a coordinator drives one transition at a time. */
export interface ReconciliationState {
  /** Active binding view: keys with a published provider instance. */
  readonly activeBindings: Map<CapabilityKey<unknown>, ProviderInstance>
}

/**
 * Run one activation to completion.
 *
 * The setup runs inside one tracked effect of the component's owner, so every resource it
 * acquires is owned by this activation. The staged bindings stay invisible until the
 * caller validates and publishes them.
 *
 * @param record - Component being activated.
 * @param state - Binding views the activation reads and will publish into.
 * @returns A promise that settles after setup and every admitted operation.
 */
export async function runActivation(
  record: ComponentRecord,
  state: ReconciliationState,
): Promise<void> {
  const view = new Map<CapabilityKey<unknown>, ProviderInstance>()
  for (const key of record.requires) {
    const instance = state.activeBindings.get(key)
    if (instance !== undefined) view.set(key, instance)
  }
  const attempt: ActivationAttempt = {
    owner: new EffectOwner(record.label),
    effect: undefined,
    view,
    staged: new Map(),
    signal: undefined,
  }
  record.owner = attempt.owner
  record.cleanupCount = 0
  record.attemptView = attempt.view
  record.staged = undefined

  const context = new ActivationContext(record, attempt, (key, value) => {
    if (attempt.staged.has(key)) {
      throw new CapabilityBindingInvalidError(record.label, key.name, 'duplicate')
    }
    attempt.staged.set(key, value)
  })

  // The activation is the only effect of this owner, so its entry settling means setup
  // finished and every operation it admitted also settled. Reaching here without throwing
  // is therefore the whole completion condition; no label comparison is involved.
  try {
    await attempt.owner.run(record.label, async effect => {
      attempt.effect = effect
      attempt.signal = effect.signal
      await record.setup(context)
    })
  } finally {
    context.close()
  }
  // Hand the offered bindings to the commit step; they stay invisible until it publishes.
  record.staged = attempt.staged
}

/**
 * Roll back a failed or interrupted activation.
 *
 * @param record - Component whose activation is being abandoned.
 */
export async function rollbackActivation(record: ComponentRecord): Promise<void> {
  record.staged = undefined
  record.attemptView = undefined
  record.committed = new Map()
  const owner = record.owner
  record.owner = undefined
  try {
    if (owner !== undefined) await owner.dispose()
  } finally {
    record.cleanupCount = 0
  }
}

/**
 * Release an active component: close its effect owner and withdraw its published bindings.
 *
 * Bindings are removed from the active view only after cleanup settles, so a consumer
 * reading during its own teardown still reaches the provider that is retiring.
 *
 * @param record - Component being deactivated.
 * @param state - Binding views to update.
 * @returns Whether cleanup succeeded.
 */
export async function runDeactivation(
  record: ComponentRecord,
  state: ReconciliationState,
): Promise<boolean> {
  record.committed = new Map()
  record.attemptView = undefined
  const owner = record.owner
  record.owner = undefined
  const attempted = record.cleanupCount
  record.cleanupCount = 0
  let failure: unknown
  if (owner !== undefined) {
    try {
      await owner.dispose()
    } catch (reason) {
      failure = reason
    }
  }

  // Withdraw the bindings regardless of cleanup outcome: a failing inverse must not pin a
  // provider in place and block every component that waits on it.
  for (const key of record.provides) {
    const instance = state.activeBindings.get(key)
    if (instance?.component === record.id) {
      state.activeBindings.delete(key)
    }
  }

  if (failure !== undefined) {
    const failed = failure instanceof EffectDisposalFailedError
      ? Math.max(1, failure.cleanupFailures.length)
      : 1
    record.failure = new ComponentDeactivationFailedError(
      record.label,
      Math.max(attempted, failed),
      failed,
      failure,
    )
    record.failurePhase = 'deactivation'
    return false
  }
  record.failure = undefined
  record.failurePhase = undefined
  return true
}

/**
 * Publish the staged bindings of a completed activation.
 *
 * @param record - Component that finished activating.
 * @param state - Binding views to extend.
 * @returns Whether the bindings were valid and are now visible.
 */
export function commitActivation(record: ComponentRecord, state: ReconciliationState): boolean {
  const staged = record.staged
  const attemptView = record.attemptView
  if (staged === undefined || attemptView === undefined) return false
  try {
    publishBindings(record, staged, state.activeBindings)
    // The committed view names what this component resolves: its required keys and the
    // instance each one came from. Copying the whole captured view would also record keys
    // the component never declared, and the next evaluation compares key sets, so it would
    // read that surplus as a change and deactivate the component immediately.
    const committed = new Map<CapabilityKey<unknown>, ProviderInstance>()
    for (const key of record.requires) {
      const instance = attemptView.get(key)
      if (instance !== undefined) committed.set(key, instance)
    }
    record.committed = committed
    record.staged = undefined
    record.attemptView = undefined
    return true
  } catch (reason) {
    record.failure = reason
    record.failurePhase = 'activation'
    return false
  }
}

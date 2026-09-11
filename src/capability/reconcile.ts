import { EffectOwner } from '../effect/index.js'
import { ActivationContext, publishBindings } from './record.js'
import type { ActivationAttempt, ComponentRecord } from './record.js'
import { ComponentActivationFailedError, ComponentDeactivationFailedError } from './errors.js'
import type { CapabilityKey, ProviderInstance } from './types.js'

/** What a transition did, so the coordinator knows whether to keep going. */
export type TransitionResult = 'progress' | 'idle'

/** Mutable state a coordinator drives one transition at a time. */
export interface ReconciliationState {
  /** Active binding view: keys with a published provider instance. */
  readonly activeBindings: Map<CapabilityKey<unknown>, ProviderInstance>
  /** Diagnostic view of what each key is bound to, shared with consumers. */
  readonly bindings: Map<CapabilityKey<unknown>, unknown>
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

async function disposeOwner(owner: EffectOwner): Promise<void> {
  await owner.dispose()
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
 * @returns Whether the activation committed.
 */
export async function runActivation(
  record: ComponentRecord,
  state: ReconciliationState,
): Promise<boolean> {
  const attempt: ActivationAttempt = {
    owner: new EffectOwner(record.label),
    view: new Map(state.activeBindings),
    staged: new Map(),
    signal: undefined as unknown as AbortSignal,
  }
  record.owner = attempt.owner
  record.attemptView = attempt.view
  record.staged = undefined

  const context = new ActivationContext(record, attempt, (key, value) => {
    attempt.staged.set(key, value)
  })

  const lease = await attempt.owner.run(record.label, async effect => {
    attempt.signal = effect.signal
    await record.setup(context)
  })
  // The activation is the only effect of this owner, so its entry settling means setup
  // finished and every operation it admitted also settled.
  context.close()
  record.staged = attempt.staged

  if (lease.label !== record.label) return false
  return true
}

/**
 * Roll back a failed or interrupted activation.
 *
 * @param record - Component whose activation is being abandoned.
 * @param reason - Original reason, retained on the record.
 */
export async function rollbackActivation(record: ComponentRecord, reason: unknown): Promise<void> {
  record.staged = undefined
  record.attemptView = undefined
  record.committed = new Map()
  const owner = record.owner
  record.owner = undefined
  record.failure = reason
  if (owner !== undefined) await disposeOwner(owner)
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
  const teardown = record.teardown
  record.teardown = undefined

  let failed = false
  if (owner !== undefined) {
    try {
      await disposeOwner(owner)
    } catch {
      failed = true
    }
  }
  if (teardown !== undefined) {
    try {
      await teardown()
    } catch {
      failed = true
    }
  }

  // Withdraw the bindings regardless of cleanup outcome: a failing inverse must not pin a
  // provider in place and block every component that waits on it.
  for (const key of record.provides) {
    const instance = state.activeBindings.get(key)
    if (instance?.component === record.id) {
      state.activeBindings.delete(key)
      state.bindings.delete(key)
    }
  }

  if (failed) {
    record.failure = new ComponentDeactivationFailedError(record.label, 1, 1)
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
    const published = publishBindings(record, staged, state.activeBindings)
    // The committed view is what this component is bound to: the dependencies it captured
    // plus the bindings it just published. Recording only its own bindings would make the
    // next evaluation read every dependency as a change.
    const committed = new Map(attemptView)
    for (const binding of published.instance.bindings) committed.set(binding.key, published.instance)
    record.committed = committed
    record.teardown = () => Promise.resolve()
    for (const binding of published.instance.bindings) {
      state.bindings.set(binding.key, binding.value)
    }
    record.staged = undefined
    record.attemptView = undefined
    return true
  } catch (reason) {
    record.failure = new ComponentActivationFailedError(record.label, reason, 0)
    record.failurePhase = 'activation'
    return false
  }
}

/** Describe a failure reason for diagnostics; kept here to avoid an error import cycle. */
export function describeFailure(reason: unknown): string {
  return messageOf(reason)
}

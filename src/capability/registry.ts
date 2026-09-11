import { AsyncLocalStorage } from 'node:async_hooks'
import { detectCycles, evaluate } from './evaluate.js'
import type { ChangeClassification } from './evaluate.js'
import { assertClaimAvailable, createHandle, projectFailure, toDeclaration } from './record.js'
import type { ComponentRecord } from './record.js'
import {
  commitActivation,
  rollbackActivation,
  runActivation,
  runDeactivation,
} from './reconcile.js'
import type { ReconciliationState } from './reconcile.js'
import {
  CapabilityBindingInvalidError,
  CapabilityKeyNameConflictError,
  ComponentActivationFailedError,
  ComponentDeactivationFailedError,
  ComponentInactiveError,
  ComponentRetryUnsatisfiedError,
  RegistryReentrantWaitError,
} from './errors.js'
import type {
  CapabilityKey,
  CapabilityCycleSnapshot,
  ComponentDefinition,
  ComponentHandle,
  ComponentId,
  ComponentSnapshot,
  ProviderSnapshot,
  RegistrySnapshot,
  RegistryStatus,
} from './types.js'

interface PendingBarrier {
  readonly resolve: (snapshot: RegistrySnapshot) => void
  readonly reject: (reason: unknown) => void
}

interface LifecycleExecution {
  readonly record: ComponentRecord
  readonly phase: 'activation' | 'deactivation'
  active: boolean
}

/**
 * Registry of mounted components and the capabilities they publish.
 *
 * Mutation is synchronous and only records intent. Every transition runs inside one
 * serial executor, so a transition commits only after the coordinator rechecks its
 * captured dependencies, and no user code runs inside a synchronous critical section.
 */
export class CapabilityRegistry {
  readonly #components = new Map<ComponentId, ComponentRecord>()
  readonly #state: ReconciliationState = { activeBindings: new Map() }
  readonly #lifecycleExecution = new AsyncLocalStorage<LifecycleExecution>()
  #status: RegistryStatus = 'accepting'
  #revision = 0
  #nextOrdinal = 0
  #nextId = 0
  #nextFailureSequence = 0
  #queue: Promise<unknown> = Promise.resolve()
  #pumping = false
  #settleRequested = false
  #pendingSettles: PendingBarrier[] = []
  #disposalTask: Promise<void> | undefined
  readonly #maxSteps: number

  /**
   * Create a registry.
   *
   * @param options - Deployment-varying bounds.
   */
  constructor(options: { readonly maxReconciliationSteps?: number } = {}) {
    const maxSteps = options.maxReconciliationSteps ?? 10_000
    if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
      throw new TypeError('maxReconciliationSteps must be a positive safe integer')
    }
    this.#maxSteps = maxSteps
  }

  /** Lifecycle state of this registry. */
  get status(): RegistryStatus {
    return this.#status
  }

  /**
   * Mount a component and reserve the keys it declares as offered.
   *
   * Mounting registers intent only: it runs no user code and starts no transition. The
   * component activates later, once its requirements resolve.
   *
   * @param definition - What the component needs, offers, and runs when satisfied.
   * @returns A handle for observing and releasing the component.
   * @throws {CapabilityKeyNameConflictError} If two different keys share one name.
   * @throws {CapabilityProviderConflictError} If a declared key is already claimed.
   */
  mount(definition: ComponentDefinition): ComponentHandle {
    if (this.#status !== 'accepting') {
      throw new ComponentInactiveError(this.#status, 'mount()')
    }

    const ordinal = this.#nextOrdinal
    this.#nextId += 1
    const id = `c${this.#nextId}` as ComponentId
    const record: ComponentRecord = {
      id,
      label: definition.label,
      ordinal,
      requires: [...definition.requires],
      provides: [...definition.provides],
      setup: async context => {
        await definition.setup(context)
      },
      status: 'unsatisfied',
      releasing: false,
      committed: new Map(),
      attemptView: undefined,
      staged: undefined,
      owner: undefined,
      cleanupCount: 0,
      providerSequence: 0,
      interruption: undefined,
      failurePhase: undefined,
      failure: undefined,
      failureSequence: undefined,
      busy: false,
      releaseTask: undefined,
      retryTask: undefined,
    }

    this.#components.set(id, record)
    try {
      this.#assertDeclarationValid(record)
    } catch (reason) {
      this.#components.delete(id)
      throw reason
    }

    this.#nextOrdinal += 1
    this.#touch()
    return createHandle(
      record,
      () => this.#retry(record),
      () => this.#release(record),
    )
  }

  /**
   * Wait until the registry reaches its next quiescent point.
   *
   * The barrier settles at the first coordinator quiescent point after the call. Mutations
   * accepted before that point are included in the same reconciliation pass.
   *
   * @returns The snapshot taken at that quiescent point.
   * @throws {ComponentInactiveError} If the registry was released.
   */
  whenQuiescent(): Promise<RegistrySnapshot> {
    if (this.#status === 'disposed') {
      return Promise.reject(new ComponentInactiveError(this.#status, 'whenQuiescent()'))
    }
    const lifecycle = this.#activeLifecycle()
    if (lifecycle !== undefined) {
      return Promise.reject(new RegistryReentrantWaitError(lifecycle.record.label, lifecycle.phase))
    }
    return this.#barrier()
  }

  #barrier(): Promise<RegistrySnapshot> {
    return new Promise<RegistrySnapshot>((resolve, reject) => {
      this.#pendingSettles.push({ resolve, reject })
      this.#pump()
    })
  }

  /**
   * Read a JSON-safe diagnostic view of the registry.
   *
   * @returns The current snapshot.
   */
  snapshot(): RegistrySnapshot {
    const components: ComponentSnapshot[] = []
    const declarationEntries = new Map<string, string[]>()
    const unresolvedEntries = new Map<string, string[]>()
    const live = this.#ordered().filter(record => record.status !== 'disposed')

    for (const record of this.#ordered()) {
      components.push(this.#projectComponent(record))
      if (record.status === 'disposed') continue
      for (const key of [...record.requires, ...record.provides]) {
        const owners = declarationEntries.get(key.name) ?? []
        if (!owners.includes(record.id)) owners.push(record.id)
        declarationEntries.set(key.name, owners)
      }
      for (const key of record.requires) {
        if (this.#isResolvable(key)) continue
        const waiting = unresolvedEntries.get(key.name) ?? []
        waiting.push(record.id)
        unresolvedEntries.set(key.name, waiting)
      }
    }

    const providers: ProviderSnapshot[] = []
    const seen = new Set<string>()
    for (const instance of this.#state.activeBindings.values()) {
      if (seen.has(instance.id)) continue
      seen.add(instance.id)
      providers.push({
        id: instance.id,
        component: instance.component,
        keys: instance.bindings.map(binding => binding.key.name),
      })
    }

    const cycles: CapabilityCycleSnapshot[] = detectCycles(live.map(toDeclaration)).map(cycle => ({
      ids: cycle.ids,
      labels: cycle.labels,
      keyNames: cycle.keyNames,
    }))
    const declarations = Object.fromEntries(declarationEntries)
    const unresolved = Object.fromEntries(unresolvedEntries)
    return { revision: this.#revision, components, providers, cycles, declarations, unresolved }
  }

  /**
   * Release every mounted component and wait for all cleanup to settle.
   *
   * @returns A promise that settles after the registry reaches its terminal state.
   */
  dispose(): Promise<void> {
    const lifecycle = this.#activeLifecycle()
    if (this.#disposalTask !== undefined) {
      if (lifecycle !== undefined) {
        void this.#disposalTask.catch(() => undefined)
        return Promise.reject(new RegistryReentrantWaitError(lifecycle.record.label, lifecycle.phase))
      }
      return this.#disposalTask
    }
    this.#status = 'disposing'
    const targets = this.#ordered().filter(record => record.status !== 'disposed')
    const failuresBeforeDisposal = new Map(targets.map(record => [record.id, record.failure]))
    for (const record of targets) record.releasing = true
    this.#interruptInvalidActivations()
    this.#touch()
    const disposal = this.#barrier().then(() => {
      const failures = targets
        .filter(record => record.failure !== undefined && (
          record.failurePhase === 'deactivation'
          || record.failure !== failuresBeforeDisposal.get(record.id)
        ))
        .sort((left, right) =>
          (left.failureSequence ?? Number.MAX_SAFE_INTEGER)
          - (right.failureSequence ?? Number.MAX_SAFE_INTEGER))
        .map(record => record.failure)
      this.#status = 'disposed'
      if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} component cleanup failure(s) during registry disposal`)
      }
    }, reason => {
      this.#status = 'disposed'
      throw reason
    })
    this.#disposalTask = disposal
    if (lifecycle !== undefined) {
      void disposal.catch(() => undefined)
      return Promise.reject(new RegistryReentrantWaitError(lifecycle.record.label, lifecycle.phase))
    }
    return disposal
  }

  #statuses(): readonly string[] {
    return this.#ordered().map(record => `${record.label}:${record.status}`)
  }

  #hasActiveDependents(record: ComponentRecord): boolean {
    if (record.provides.length === 0) return false
    for (const other of this.#components.values()) {
      if (other.id === record.id) continue
      // A dependent that is deactivating still holds its bindings until its cleanup
      // settles, so the provider keeps waiting for it too.
      if (other.status === 'unsatisfied' || other.status === 'failed' || other.status === 'disposed') continue
      for (const key of other.requires) {
        if (record.provides.includes(key)) return true
      }
    }
    return false
  }

  #targetDrifted(record: ComponentRecord): boolean {
    const view = record.attemptView
    if (view === undefined) return false
    for (const key of record.requires) {
      if (!this.#isResolvable(key)) return true
      if (this.#state.activeBindings.get(key)?.id !== view.get(key)?.id) return true
    }
    return false
  }

  #isResolvable(key: CapabilityKey<unknown>): boolean {
    const instance = this.#state.activeBindings.get(key)
    if (instance === undefined) return false
    const provider = this.#components.get(instance.component)
    return provider !== undefined
      && !provider.releasing
      && provider.status !== 'deactivating'
      && provider.status !== 'disposed'
  }

  #activeLifecycle(): LifecycleExecution | undefined {
    const lifecycle = this.#lifecycleExecution.getStore()
    return lifecycle?.active === true ? lifecycle : undefined
  }

  #interruptInvalidActivations(): void {
    const invalidated = new Set<ComponentId>()
    for (const candidate of this.#components.values()) {
      if (candidate.releasing || candidate.status === 'deactivating' || candidate.status === 'disposed') {
        invalidated.add(candidate.id)
      }
    }

    // A provider that relies on an invalidated provider will also have to stop. Propagate
    // that fact through committed and in-flight dependency views before aborting setup, so
    // an activating leaf cannot hold the serial coordinator while its indirect provider
    // waits to retire.
    let changed = true
    while (changed) {
      changed = false
      for (const candidate of this.#components.values()) {
        if (invalidated.has(candidate.id)) continue
        const view = candidate.status === 'activating' ? candidate.attemptView : candidate.committed
        if ([...(view?.values() ?? [])].some(instance => invalidated.has(instance.component))) {
          invalidated.add(candidate.id)
          changed = true
        }
      }
    }

    for (const candidate of this.#components.values()) {
      if (candidate.status !== 'activating' || candidate.owner === undefined) continue
      const dependencyRetired = [...(candidate.attemptView?.values() ?? [])]
        .some(instance => invalidated.has(instance.component))
      const interruption = candidate.releasing ? 'release' : dependencyRetired ? 'dependency' : undefined
      if (interruption === undefined || candidate.interruption !== undefined) continue
      candidate.interruption = interruption
      const owner = candidate.owner
      queueMicrotask(() => {
        void owner.dispose().catch(() => undefined)
      })
    }
  }

  #ordered(): readonly ComponentRecord[] {
    return [...this.#components.values()].sort((a, b) => a.ordinal - b.ordinal)
  }

  #projectComponent(record: ComponentRecord): ComponentSnapshot {
    const committed = Object.fromEntries(
      [...record.committed].map(([key, instance]) => [key.name, instance.id]),
    )
    return {
      id: record.id,
      label: record.label,
      status: record.status,
      requires: record.requires.map(key => key.name),
      provides: record.provides.map(key => key.name),
      committed,
      ...(record.failurePhase === undefined ? {} : { failurePhase: record.failurePhase }),
      ...(record.busy ? { task: record.status === 'deactivating' ? 'deactivation' as const : 'activation' as const } : {}),
      ...(record.failure === undefined ? {} : { failure: projectFailure(record.failure) }),
    }
  }

  #assertDeclarationValid(record: ComponentRecord): void {
    this.#assertNoDuplicateKeys(record, 'requires')
    this.#assertNoDuplicateKeys(record, 'provides')
    const seen = new Map<string, {
      readonly key: CapabilityKey<unknown>
      readonly record: ComponentRecord
    }>()
    // A name that two different keys share would make diagnostics lie about which
    // capability a component means, so the registry refuses it instead of resolving by
    // name. The check spans every mounted component, not this record alone.
    for (const other of this.#components.values()) {
      if (other.status === 'disposed') continue
      for (const key of [...other.requires, ...other.provides]) {
        const existing = seen.get(key.name)
        if (existing !== undefined && existing.key !== key) {
          throw new CapabilityKeyNameConflictError(
            key.name,
            [existing.record.label, other.label],
            [existing.record.id, other.id],
          )
        }
        seen.set(key.name, { key, record: other })
      }
    }
    // Only offered keys reserve ownership; requiring a key is not a claim on it.
    for (const key of new Set(record.provides)) {
      assertClaimAvailable(record, key, this.#components.values())
    }
  }

  #assertNoDuplicateKeys(record: ComponentRecord, field: 'requires' | 'provides'): void {
    const seen = new Set<CapabilityKey<unknown>>()
    for (const key of record[field]) {
      if (seen.has(key)) {
        throw new CapabilityBindingInvalidError(record.label, key.name, 'duplicate')
      }
      seen.add(key)
    }
  }

  #retry(record: ComponentRecord): Promise<void> {
    const lifecycle = this.#activeLifecycle()
    if (record.retryTask !== undefined) {
      if (lifecycle !== undefined) {
        void record.retryTask.catch(() => undefined)
        return Promise.reject(new RegistryReentrantWaitError(lifecycle.record.label, lifecycle.phase))
      }
      return record.retryTask
    }
    if (record.status !== 'failed') {
      return Promise.reject(new ComponentInactiveError(record.status, 'retry()', record.label))
    }
    const missing = this.#missingKeys(record)
    if (missing.length > 0) {
      return Promise.reject(new ComponentRetryUnsatisfiedError(record.label, missing))
    }
    record.status = 'unsatisfied'
    record.failure = undefined
    record.failurePhase = undefined
    record.failureSequence = undefined
    this.#touch()
    const task = this.#barrier().then(() => undefined)
    record.retryTask = task.finally(() => {
      record.retryTask = undefined
    })
    if (lifecycle !== undefined) {
      void record.retryTask.catch(() => undefined)
      return Promise.reject(new RegistryReentrantWaitError(lifecycle.record.label, lifecycle.phase))
    }
    return record.retryTask
  }

  #release(record: ComponentRecord): Promise<void> {
    const lifecycle = this.#activeLifecycle()
    if (record.releaseTask !== undefined) {
      if (lifecycle !== undefined) {
        void record.releaseTask.catch(() => undefined)
        return Promise.reject(new RegistryReentrantWaitError(lifecycle.record.label, lifecycle.phase))
      }
      return record.releaseTask
    }
    if (record.status === 'disposed') {
      record.releaseTask = record.failure !== undefined
        ? Promise.reject(record.failure)
        : Promise.resolve()
      return record.releaseTask
    }
    // Recording the request is synchronous; the executor owns the transitions that carry
    // it out, so lifecycle code calling this cannot wait for the reconciliation running it.
    record.releasing = true
    this.#interruptInvalidActivations()
    this.#touch()
    const task = this.#barrier().then(() => {
      if (record.failure !== undefined) {
        throw record.failure
      }
    })
    record.releaseTask = task
    if (lifecycle !== undefined) {
      void task.catch(() => undefined)
      return Promise.reject(new RegistryReentrantWaitError(lifecycle.record.label, lifecycle.phase))
    }
    return task
  }

  #missingKeys(record: ComponentRecord): string[] {
    const missing: string[] = []
    for (const key of record.requires) {
      if (!this.#isResolvable(key)) missing.push(key.name)
    }
    return missing
  }

  #touch(): void {
    this.#revision += 1
    this.#pump()
  }

  /**
   * Ensure the queue holds a task that reconciles the graph and settles the barrier.
   *
   * A running pump already performs both, so a mutation or barrier arriving during one
   * records that another pass is needed. This also covers a barrier registered by a
   * reaction to a barrier that the current drain just resolved.
   *
   */
  #pump(): void {
    if (this.#pumping) {
      // A barrier can be registered by a reaction to one that this drain just resolved,
      // before the queue continuation clears `#pumping`. Always schedule a following pass
      // so that late barrier cannot be stranded without another mutation.
      this.#settleRequested = true
      return
    }
    this.#pumping = true
    this.#settleRequested = false
    const settled = this.#queue.then(
      () => this.#drain(),
      () => this.#drain(),
    )
    this.#queue = settled.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      // Reset synchronously and read the flag in the same section, so a mutation that
      // arrives while this continuation runs is neither lost nor left unsettled.
      const again = this.#settleRequested
      this.#pumping = false
      this.#settleRequested = false
      if (again) this.#pump()
    })
  }

  async #drain(): Promise<void> {
    try {
      await this.#reconcileUntilSettled()
      const pending = [...this.#pendingSettles]
      this.#pendingSettles = []
      const snapshot = this.snapshot()
      for (const barrier of pending) barrier.resolve(snapshot)
    } catch (reason) {
      const pending = [...this.#pendingSettles]
      this.#pendingSettles = []
      for (const barrier of pending) barrier.reject(reason)
      throw reason
    }
  }

  /**
   * Drive the transitions that belong to the changes recorded so far.
   *
   * A blocked pass means no transition can advance from the current graph. That is a
   * stopping point rather than a reason to spin. A later mutation starts a new pass, and a
   * pass that makes progress keeps going on its own.
   */
  async #reconcileUntilSettled(): Promise<void> {
    for (let guard = 0; ; guard += 1) {
      if (guard > this.#maxSteps) {
        throw new Error(`reconciliation did not converge: ${JSON.stringify(this.#statuses())}`)
      }
      const outcome = await this.#step()
      if (outcome !== 'progress') return
    }
  }

  async #step(): Promise<'progress' | 'blocked' | 'settled'> {
    const records = this.#ordered()
    const live = records.filter(record => record.status !== 'disposed')
    const result = evaluate({
      declarations: live.map(toDeclaration),
      activeBindings: this.#state.activeBindings,
    })
    const byId = new Map(records.map(record => [record.id, record]))
    const changesById = new Map(result.changes.map(change => [change.id, change]))
    const activationSet = new Set(result.activationOrder)
    const deactivationSet = new Set(result.deactivationOrder)
    // Deactivation is driven first and in reverse dependency order, so a provider never
    // withdraws before the consumers that resolve to it have finished. Activation then
    // runs in dependency order.
    for (const id of result.deactivationOrder) {
      const record = byId.get(id)
      if (record === undefined) continue
      if (await this.#transition(record, 'deactivating', deactivationSet)) return 'progress'
    }
    for (const id of result.activationOrder) {
      const record = byId.get(id)
      if (record === undefined) continue
      if (await this.#transition(record, 'activating', activationSet)) return 'progress'
    }
    for (const record of records) {
      const change = changesById.get(record.id)
      if (change === undefined) continue
      if (await this.#transition(record, change.classification, activationSet)) return 'progress'
    }

    // A transitional record can be blocked by another retained binding in an inconsistent
    // graph. Report that state instead of spinning until the convergence guard fails.
    const remaining = records.some(record =>
      record.status === 'activating' || record.status === 'deactivating')
    return remaining ? 'blocked' : 'settled'
  }

  async #transition(
    record: ComponentRecord,
    classification: ChangeClassification,
    activationSet: ReadonlySet<ComponentId>,
  ): Promise<boolean> {
    return await this.#applyStatus(record, classification, activationSet)
  }

  async #applyStatus(
    record: ComponentRecord,
    classification: ChangeClassification,
    activationSet: ReadonlySet<ComponentId>,
  ): Promise<boolean> {
    switch (record.status) {
      case 'unsatisfied': {
        if (record.releasing) {
          record.status = 'disposed'
          return true
        }
        if (classification !== 'activating' || !activationSet.has(record.id)) return false
        record.busy = true
        record.status = 'activating'
        const lifecycle: LifecycleExecution = { record, phase: 'activation', active: true }
        try {
          await this.#lifecycleExecution.run(
            lifecycle,
            () => runActivation(record, this.#state),
          )
        } catch (reason) {
          const interrupted = record.interruption !== undefined || record.releasing
          await this.#abandonActivation(record, reason, interrupted)
        } finally {
          lifecycle.active = false
          record.busy = false
        }
        return true
      }
      case 'activating': {
        record.busy = true
        try {
          // The evaluator compares against the captured attempt view. A release request or
          // a retiring dependency therefore abandons this attempt before it can publish.
          if (record.releasing || classification === 'deactivating' || this.#targetDrifted(record)) {
            await this.#abandonActivation(
              record,
              new Error('target view drifted during activation'),
              true,
            )
            return true
          }
          if (commitActivation(record, this.#state)) {
            record.status = 'active'
            record.failure = undefined
            record.failurePhase = undefined
            record.failureSequence = undefined
            record.interruption = undefined
          } else {
            await this.#abandonActivation(record, record.failure, false)
          }
        } finally {
          record.busy = false
        }
        return true
      }
      case 'active':
        if (classification !== 'deactivating') return false
        record.status = 'deactivating'
        return true
      case 'deactivating': {
        // A provider waits for the consumers that resolve to it: its bindings stay
        // published, and readable, until each of them has finished deactivating.
        if (this.#hasActiveDependents(record)) return false
        record.busy = true
        let succeeded = false
        const lifecycle: LifecycleExecution = { record, phase: 'deactivation', active: true }
        try {
          succeeded = await this.#lifecycleExecution.run(
            lifecycle,
            () => runDeactivation(record, this.#state),
          )
        } catch (reason) {
          record.failure = new ComponentDeactivationFailedError(record.label, 1, 1, reason)
          record.failurePhase = 'deactivation'
        } finally {
          lifecycle.active = false
          record.busy = false
        }
        if (!succeeded) {
          this.#nextFailureSequence += 1
          record.failureSequence = this.#nextFailureSequence
        } else {
          record.failureSequence = undefined
        }
        if (record.releasing) {
          record.status = 'disposed'
          return true
        }
        record.status = succeeded ? 'unsatisfied' : 'failed'
        return true
      }
      case 'failed':
        if (record.releasing) {
          if (record.failurePhase === 'activation') {
            record.failure = undefined
            record.failurePhase = undefined
            record.failureSequence = undefined
          }
          record.status = 'disposed'
          return true
        }
        return false
      case 'disposed':
        return false
      default:
        return false
    }
  }

  async #abandonActivation(
    record: ComponentRecord,
    reason: unknown,
    expectedInterruption: boolean,
  ): Promise<void> {
    const rollbackAttempted = record.cleanupCount
    let rollbackFailure: unknown
    try {
      await rollbackActivation(record)
    } catch (caught) {
      rollbackFailure = caught
    }
    record.interruption = undefined

    if (expectedInterruption && rollbackFailure === undefined) {
      record.failure = undefined
      record.failurePhase = undefined
      record.failureSequence = undefined
      record.status = record.releasing ? 'disposed' : 'unsatisfied'
      return
    }

    const failureReason = rollbackFailure === undefined
      ? reason
      : new AggregateError([reason, rollbackFailure], `activation and rollback failed for "${record.label}"`)
    record.failure = new ComponentActivationFailedError(record.label, failureReason, rollbackAttempted)
    record.failurePhase = 'activation'
    record.failureSequence = undefined
    record.status = record.releasing ? 'disposed' : 'failed'
  }
}

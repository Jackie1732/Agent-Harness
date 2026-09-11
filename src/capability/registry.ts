import { evaluate } from './evaluate.js'
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
  CapabilityKeyNameConflictError,
  CapabilityUnsatisfiedError,
  ComponentActivationFailedError,
  ComponentInactiveError,
  RegistryReentrantWaitError,
} from './errors.js'
import type {
  CapabilityKey,
  ComponentDefinition,
  ComponentHandle,
  ComponentId,
  ComponentSnapshot,
  ProviderSnapshot,
  RegistrySnapshot,
  RegistryStatus,
} from './types.js'

/**
 * Registry of mounted components and the capabilities they publish.
 *
 * Mutation is synchronous and only records intent. Every transition runs inside one
 * serial executor, so two changes can never apply an outdated evaluation, and no user
 * code runs inside a synchronous critical section.
 */
export class CapabilityRegistry {
  readonly #components = new Map<ComponentId, ComponentRecord>()
  readonly #state: ReconciliationState = { activeBindings: new Map(), bindings: new Map() }
  #status: RegistryStatus = 'accepting'
  #revision = 0
  #nextOrdinal = 0
  #nextId = 0
  #queue: Promise<unknown> = Promise.resolve()
  #pumping = false
  #settleRequested = false
  #pendingSettles: (() => void)[] = []
  #inCleanup: ComponentRecord | undefined
  readonly #maxSteps: number

  /**
   * Create a registry.
   *
   * @param options - Deployment-varying bounds.
   */
  constructor(options: { readonly maxReconciliationSteps?: number } = {}) {
    this.#maxSteps = options.maxReconciliationSteps ?? 10_000
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
      teardown: undefined,
      owner: undefined,
      failurePhase: undefined,
      failure: undefined,
      busy: false,
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
   * The barrier settles after every change pending at the call has been reconciled,
   * including the chained activations and deactivations those changes cause. Changes that
   * arrive later do not extend it, so a caller that keeps mutating still observes an
   * answer.
   *
   * @returns The snapshot taken at that quiescent point.
   * @throws {ComponentInactiveError} If the registry was released.
   */
  whenQuiescent(): Promise<RegistrySnapshot> {
    if (this.#status === 'disposed') {
      return Promise.reject(new ComponentInactiveError(this.#status, 'whenQuiescent()'))
    }
    // A barrier taken inside cleanup would wait for the reconciliation that is running the
    // cleanup itself, which can never settle. Registering work instead is always allowed.
    if (this.#inCleanup !== undefined) {
      return Promise.reject(new RegistryReentrantWaitError(this.#inCleanup.label, 'reconciliation'))
    }
    return new Promise<RegistrySnapshot>(resolve => {
      this.#pendingSettles.push(() => resolve(this.snapshot()))
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
    const declarations: Record<string, string[]> = {}
    const unresolved: Record<string, string[]> = {}

    for (const record of this.#ordered()) {
      components.push(this.#projectComponent(record))
      for (const key of [...record.requires, ...record.provides]) {
        const owners = declarations[key.name] ?? []
        if (!owners.includes(record.id)) owners.push(record.id)
        declarations[key.name] = owners
      }
      for (const key of record.requires) {
        if (this.#state.activeBindings.has(key)) continue
        const waiting = unresolved[key.name] ?? []
        waiting.push(record.id)
        unresolved[key.name] = waiting
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

    return { revision: this.#revision, components, providers, declarations, unresolved }
  }

  /**
   * Release every mounted component and wait for all cleanup to settle.
   *
   * @returns A promise that settles after the registry reaches its terminal state.
   */
  dispose(): Promise<void> {
    if (this.#status === 'disposed') return this.#queue.then(() => undefined)
    this.#status = 'disposing'
    for (const record of this.#components.values()) record.releasing = true
    this.#touch()
    return new Promise<void>(resolve => {
      this.#pendingSettles.push(() => {
        this.#status = 'disposed'
        resolve()
      })
      this.#pump()
    })
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
      if (this.#state.activeBindings.get(key)?.id !== view.get(key)?.id) return true
    }
    return false
  }

  #ordered(): readonly ComponentRecord[] {
    return [...this.#components.values()].sort((a, b) => a.ordinal - b.ordinal)
  }

  #projectComponent(record: ComponentRecord): ComponentSnapshot {
    const committed: Record<string, string> = {}
    for (const [key, instance] of record.committed) committed[key.name] = instance.id
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
    const seen = new Map<string, CapabilityKey<unknown>>()
    // A name that two different keys share would make diagnostics lie about which
    // capability a component means, so the registry refuses it instead of resolving by
    // name. The check spans every mounted component, not this record alone.
    for (const other of this.#components.values()) {
      for (const key of [...other.requires, ...other.provides]) {
        const existing = seen.get(key.name)
        if (existing !== undefined && existing !== key) {
          throw new CapabilityKeyNameConflictError(
            key.name,
            [other.label, ...this.#labelsClaiming(key.name, other)],
          )
        }
        seen.set(key.name, key)
      }
    }
    // Only offered keys reserve ownership; requiring a key is not a claim on it.
    for (const key of new Set(record.provides)) {
      assertClaimAvailable(record, key, this.#components.values())
    }
  }

  #labelsClaiming(keyName: string, exclude: ComponentRecord): string[] {
    const labels: string[] = []
    for (const other of this.#components.values()) {
      if (other.id === exclude.id) continue
      for (const key of [...other.requires, ...other.provides]) {
        if (key.name === keyName) labels.push(other.label)
      }
    }
    return labels
  }

  #retry(record: ComponentRecord): Promise<void> {
    if (record.status !== 'failed') {
      return Promise.reject(new ComponentInactiveError(record.status, 'retry()', record.label))
    }
    const missing = this.#missingKeys(record)
    if (missing.length > 0) {
      return Promise.reject(new CapabilityUnsatisfiedError(record.label, missing))
    }
    record.status = 'unsatisfied'
    record.failure = undefined
    record.failurePhase = undefined
    this.#touch()
    return this.whenQuiescent().then(() => undefined)
  }

  #release(record: ComponentRecord): Promise<void> {
    if (record.status === 'disposed') return this.#queue.then(() => undefined)
    // Recording the request is synchronous; the executor owns the transitions that carry
    // it out, so a cleanup calling this cannot wait for the reconciliation running it.
    record.releasing = true
    this.#touch()
    return this.whenQuiescent().then(() => undefined)
  }

  #missingKeys(record: ComponentRecord): string[] {
    const missing: string[] = []
    for (const key of record.requires) {
      if (!this.#state.activeBindings.has(key)) missing.push(key.name)
    }
    return missing
  }

  #touch(): void {
    this.#revision += 1
    this.#pump(true)
  }

  /**
   * Ensure the queue holds a task that reconciles the graph and settles the barrier.
   *
   * A running pump already performs both, so a mutation or barrier arriving during one
   * only records that another pass is needed. Registering a barrier must not request that
   * pass by itself, or the flag would keep the pump running with nothing left to do.
   *
   * @param work - Whether this call also changed what the registry must reconcile.
   */
  #pump(work = false): void {
    if (this.#pumping) {
      if (work) this.#settleRequested = true
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
    let guard = 0
    while (await this.#step()) {
      guard += 1
      if (guard > this.#maxSteps) {
        throw new Error(`reconciliation did not converge: ${JSON.stringify(this.#statuses())}`)
      }
    }
    const pending = [...this.#pendingSettles]
    this.#pendingSettles = []
    for (const settle of pending) settle()
  }

  async #step(): Promise<boolean> {
    const records = this.#ordered()
    const result = evaluate({
      declarations: records.map(toDeclaration),
      activeBindings: this.#state.activeBindings,
    })
    const byId = new Map(records.map(record => [record.id, record]))
    const activationSet = new Set(result.activationOrder)
    const deactivationSet = new Set(result.deactivationOrder)
    let progressed = false

    // Deactivation is driven first and in reverse dependency order, so a provider never
    // withdraws before the consumers that resolve to it have finished. Activation then
    // runs in dependency order.
    for (const id of result.deactivationOrder) {
      const record = byId.get(id)
      if (record === undefined) continue
      if (await this.#transition(record, 'deactivating', deactivationSet)) progressed = true
    }
    for (const id of result.activationOrder) {
      const record = byId.get(id)
      if (record === undefined) continue
      if (await this.#transition(record, 'activating', activationSet)) progressed = true
    }
    for (const record of records) {
      const change = result.changes.find(candidate => candidate.id === record.id)
      if (change === undefined) continue
      if (change.classification === 'deactivating') continue
      if (await this.#transition(record, change.classification, activationSet)) progressed = true
    }
    return progressed
  }

  async #transition(
    record: ComponentRecord,
    classification: string,
    activationSet: ReadonlySet<ComponentId>,
  ): Promise<boolean> {
    return await this.#applyStatus(record, classification, activationSet)
  }

  async #applyStatus(
    record: ComponentRecord,
    classification: string,
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
        try {
          const completed = await runActivation(record, this.#state)
          if (!completed) throw new Error('activation did not run')
        } catch (reason) {
          await rollbackActivation(record, reason)
          record.failure = new ComponentActivationFailedError(record.label, reason, 0)
          record.failurePhase = 'activation'
          record.status = 'failed'
        }
        record.busy = false
        return true
      }
      case 'activating': {
        record.busy = true
        // Final checkpoint: the activation publishes only while the resolution it captured
        // is still the resolution the registry holds.
        if (this.#targetDrifted(record)) {
          await rollbackActivation(record, new Error('target view drifted during activation'))
          record.status = 'unsatisfied'
          record.failure = undefined
          record.failurePhase = undefined
          record.busy = false
          return true
        }
        if (commitActivation(record, this.#state)) {
          record.status = 'active'
          record.failure = undefined
          record.failurePhase = undefined
        } else {
          await rollbackActivation(record, record.failure)
          record.status = 'failed'
          record.failurePhase = 'activation'
        }
        record.busy = false
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
        // The reverter of this component is about to run, so a barrier taken from inside
        // it would wait for the reconciliation running it. Recording that lets the barrier
        // refuse instead of deadlocking, while synchronous registration stays allowed.
        this.#inCleanup = record
        let succeeded: boolean
        try {
          succeeded = await runDeactivation(record, this.#state)
        } finally {
          this.#inCleanup = undefined
        }
        record.busy = false
        if (record.releasing) {
          record.status = 'disposed'
          return true
        }
        record.status = succeeded ? 'unsatisfied' : 'failed'
        return true
      }
      case 'failed':
      case 'disposed':
        return false
      default:
        return false
    }
  }
}

import type { Awaitable } from '../effect/index.js'
import { emitEvent, invokeMiddleware } from './dispatch.js'
import {
  ScopeInactiveError,
  ScopeNotPublishedError,
  ScopeReentrantWaitError,
} from './errors.js'
import { collectSubtree } from './records.js'
import type { ScopeRecord } from './records.js'
import { RegistrationStore } from './registration-store.js'
import { TaskTracker } from './task-tracker.js'
import type {
  EventListener,
  EventName,
  MiddlewareHandler,
  MiddlewareName,
  RegistrationHandle,
  RootScope,
  Scope,
  ScopeId,
  ScopeNodeSnapshot,
  ScopeSnapshot,
  ScopeStatus,
} from './types.js'

interface ScopeBarrier {
  readonly scope: ScopeRecord
  readonly resolve: (snapshot: ScopeSnapshot) => void
}

function requireLabel(label: string): void {
  if (label.length === 0) throw new TypeError('scope label must not be empty')
}

class RootScopeFacade implements RootScope {
  constructor(private readonly tree: ScopeTree, private readonly record: ScopeRecord) {}

  get id(): ScopeId { return this.record.id }
  get label(): string { return this.record.label }
  get status(): ScopeStatus { return this.record.status }
  get signal(): AbortSignal { return this.record.abort.signal }

  on<TPayload>(
    event: EventName<TPayload>,
    label: string,
    listener: EventListener<TPayload>,
  ): RegistrationHandle {
    return this.tree.registerListener(this.record, event, label, listener)
  }

  intercept<TRequest, TResult>(
    name: MiddlewareName<TRequest, TResult>,
    label: string,
    handler: MiddlewareHandler<TRequest, TResult>,
  ): RegistrationHandle {
    return this.tree.registerMiddleware(this.record, name, label, handler)
  }

  emit<TPayload>(event: EventName<TPayload>, payload: TPayload): Promise<void> {
    return this.tree.emit(this.record, event, payload)
  }

  invoke<TRequest, TResult>(
    name: MiddlewareName<TRequest, TResult>,
    request: TRequest,
    terminal?: (request: TRequest) => Awaitable<TResult>,
  ): Promise<TResult> {
    return this.tree.invoke(this.record, name, request, terminal)
  }

  derive(label: string): Scope {
    return this.tree.derive(this.record, label)
  }

  whenQuiescent(): Promise<ScopeSnapshot> {
    return this.tree.whenQuiescent(this.record)
  }

  snapshot(): ScopeSnapshot {
    return this.tree.snapshot(this.record)
  }
}

class ScopeFacade extends RootScopeFacade implements Scope {
  constructor(
    tree: ScopeTree,
    record: ScopeRecord,
    private readonly disposeScope: () => Promise<void>,
  ) {
    super(tree, record)
  }

  dispose(): Promise<void> {
    return this.disposeScope()
  }
}

class ScopeControlImpl implements ScopeControl {
  readonly scope: Scope

  constructor(private readonly tree: ScopeTree, private readonly record: ScopeRecord) {
    this.scope = new ScopeFacade(tree, record, () => tree.dispose(record))
  }

  preparePublication(): PreparedScopePublication {
    return this.tree.preparePublication(this.record)
  }

  beginDispose(): Promise<void> {
    return this.tree.beginDispose(this.record)
  }

  reentrantError(operation: string): ScopeReentrantWaitError | undefined {
    return this.tree.reentrantError(this.record, operation)
  }
}

/** A prepared staged-Scope publication whose apply step invokes no user code. */
export interface PreparedScopePublication {
  /** Publish the prevalidated subtree in one synchronous section. */
  apply(): void
}

/** Registry-owned control over one Component activation scope. */
export interface ScopeControl {
  /** Public scope retained by Component setup and its callbacks. */
  readonly scope: Scope
  /** Validate the current staged subtree without publishing it. */
  preparePublication(): PreparedScopePublication
  /** Close the subtree and return its shared settlement task without caller re-entry checks. */
  beginDispose(): Promise<void>
  /** Return the error a public wait would receive from the current task chain. */
  reentrantError(operation: string): ScopeReentrantWaitError | undefined
}

/**
 * Private runtime tree that owns Scope topology, lifecycle transitions, and barriers.
 *
 * CapabilityRegistry owns one instance. The class is exported only for focused internal
 * tests and is not re-exported from the package entry point.
 */
export class ScopeTree {
  readonly root: RootScope
  readonly #rootRecord: ScopeRecord
  readonly #registrations: RegistrationStore
  readonly #tasks: TaskTracker
  readonly #barriers = new Set<ScopeBarrier>()
  #barrierCheckScheduled = false
  #revision = 0
  #nextScopeId = 1
  #nextScopeOrdinal = 1

  constructor() {
    this.#registrations = new RegistrationStore(() => this.#touch())
    this.#tasks = new TaskTracker(() => this.#touch())
    this.#rootRecord = {
      id: 's1' as ScopeId,
      ordinal: 1,
      label: 'root',
      status: 'accepting',
      parent: undefined,
      children: new Set(),
      abort: new AbortController(),
      registrations: new Set(),
      tasks: new Set(),
      stagingRoot: undefined,
      stagedNames: undefined,
      disposalTask: undefined,
    }
    this.root = new RootScopeFacade(this, this.#rootRecord)
  }

  /** Create a direct staged child for one Component activation. */
  createActivationScope(label: string): ScopeControl {
    requireLabel(label)
    this.#assertAccepting(this.#rootRecord, 'derive()')
    const record = this.#createRecord(this.#rootRecord, label, 'staging')
    record.stagingRoot = record
    record.stagedNames = { events: new Map(), middleware: new Map() }
    return new ScopeControlImpl(this, record)
  }

  /** Close the Root subtree for Registry disposal without applying a caller wait guard. */
  beginRootDispose(): Promise<void> {
    return this.beginDispose(this.#rootRecord)
  }

  /** Report whether Registry disposal would wait for the current extension call chain. */
  rootReentrantError(operation: string): ScopeReentrantWaitError | undefined {
    return this.reentrantError(this.#rootRecord, operation)
  }

  registerListener<TPayload>(
    scope: ScopeRecord,
    event: EventName<TPayload>,
    label: string,
    listener: EventListener<TPayload>,
  ): RegistrationHandle {
    return this.#registrations.register(
      scope,
      'listener',
      event,
      label,
      listener as EventListener<unknown>,
    )
  }

  registerMiddleware<TRequest, TResult>(
    scope: ScopeRecord,
    name: MiddlewareName<TRequest, TResult>,
    label: string,
    handler: MiddlewareHandler<TRequest, TResult>,
  ): RegistrationHandle {
    return this.#registrations.register(
      scope,
      'middleware',
      name,
      label,
      handler as unknown as MiddlewareHandler<unknown, unknown>,
    )
  }

  derive(parent: ScopeRecord, label: string): Scope {
    requireLabel(label)
    this.#assertAcceptingOrStaging(parent, 'derive()')
    const record = this.#createRecord(
      parent,
      label,
      parent.status === 'staging' ? 'staging' : 'accepting',
    )
    record.stagingRoot = parent.stagingRoot
    return new ScopeFacade(this, record, () => this.dispose(record))
  }

  emit<TPayload>(scope: ScopeRecord, event: EventName<TPayload>, payload: TPayload): Promise<void> {
    this.#assertInvocationAllowed(scope, 'emit()')
    this.#registrations.assertInvocationName('listener', event, scope, 'emit()')
    return emitEvent(scope, event, payload, this.#registrations, this.#tasks)
  }

  invoke<TRequest, TResult>(
    scope: ScopeRecord,
    name: MiddlewareName<TRequest, TResult>,
    request: TRequest,
    terminal: ((request: TRequest) => Awaitable<TResult>) | undefined,
  ): Promise<TResult> {
    this.#assertInvocationAllowed(scope, 'invoke()')
    this.#registrations.assertInvocationName('middleware', name, scope, 'invoke()')
    return invokeMiddleware(scope, name, request, terminal, this.#registrations, this.#tasks)
  }

  whenQuiescent(scope: ScopeRecord): Promise<ScopeSnapshot> {
    const reentrant = this.reentrantError(scope, 'whenQuiescent()')
    if (reentrant !== undefined) return Promise.reject(reentrant)
    if (scope.status === 'disposed') return Promise.resolve(this.snapshot(scope))
    if (scope.status === 'disposing') {
      const disposal = scope.disposalTask
      if (disposal === undefined) throw new Error('disposing scope has no settlement task')
      return disposal.then(() => this.snapshot(scope))
    }
    return new Promise<ScopeSnapshot>(resolve => {
      this.#barriers.add({ scope, resolve })
      this.#scheduleBarrierCheck()
    })
  }

  snapshot(scope: ScopeRecord): ScopeSnapshot {
    const scopes = collectSubtree(scope)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(record => this.#projectScope(record))
    return {
      revision: this.#revision,
      scopeId: String(scope.id),
      status: scope.status,
      subtreeInFlight: scopes.reduce((total, node) => total + node.ownInFlight, 0),
      scopes,
    }
  }

  dispose(scope: ScopeRecord): Promise<void> {
    const reentrant = this.reentrantError(scope, 'dispose()')
    const task = this.beginDispose(scope)
    if (reentrant !== undefined) {
      void task.catch(() => undefined)
      return Promise.reject(reentrant)
    }
    return task
  }

  beginDispose(scope: ScopeRecord): Promise<void> {
    if (scope.disposalTask !== undefined) return scope.disposalTask
    if (scope.status === 'disposed') {
      scope.disposalTask = Promise.resolve()
      return scope.disposalTask
    }

    const subtree = collectSubtree(scope)
    for (const record of subtree) {
      if (record.status === 'disposed' || record.status === 'disposing') continue
      record.status = 'disposing'
      record.abort.abort(new Error(`scope "${record.label}" is disposing`))
      for (const registration of [...record.registrations]) void this.#registrations.dispose(registration)
      this.#touch()
    }

    for (const record of [...subtree].reverse()) {
      record.disposalTask ??= this.#settleScope(record)
    }
    const task = scope.disposalTask
    if (task === undefined) throw new Error('scope disposal task was not created')
    return task
  }

  preparePublication(root: ScopeRecord): PreparedScopePublication {
    if (root.status !== 'staging') {
      throw new ScopeInactiveError(String(root.id), root.label, root.status, 'publish')
    }
    const nodes = collectSubtree(root).filter(record => record.status === 'staging')
    const registrations = nodes
      .flatMap(record => [...record.registrations])
      .filter(registration => registration.status === 'registered')
      .sort((left, right) => left.ordinal - right.ordinal)

    this.#registrations.validatePublication(registrations)

    return {
      apply: () => {
        this.#registrations.publish(registrations)
        for (const node of nodes) {
          node.status = 'accepting'
          node.stagingRoot = undefined
          this.#touch()
        }
        root.stagedNames?.events.clear()
        root.stagedNames?.middleware.clear()
        root.stagedNames = undefined
      },
    }
  }

  reentrantError(scope: ScopeRecord, operation: string): ScopeReentrantWaitError | undefined {
    return this.#tasks.reentrantError(scope, operation)
  }

  #createRecord(parent: ScopeRecord, label: string, status: 'staging' | 'accepting'): ScopeRecord {
    this.#nextScopeId += 1
    this.#nextScopeOrdinal += 1
    const record: ScopeRecord = {
      id: `s${this.#nextScopeId}` as ScopeId,
      ordinal: this.#nextScopeOrdinal,
      label,
      status,
      parent,
      children: new Set(),
      abort: new AbortController(),
      registrations: new Set(),
      tasks: new Set(),
      stagingRoot: undefined,
      stagedNames: undefined,
      disposalTask: undefined,
    }
    parent.children.add(record)
    this.#touch()
    return record
  }

  async #settleScope(scope: ScopeRecord): Promise<void> {
    const children = [...scope.children]
      .filter(child => child.status !== 'disposed')
      .map(child => this.beginDispose(child))
    await Promise.all(children)
    while (scope.tasks.size > 0) {
      await Promise.all([...scope.tasks].map(task => task.settled))
    }
    scope.status = 'disposed'
    if (scope.parent !== undefined) scope.parent.children.delete(scope)
    this.#touch()
  }

  #projectScope(record: ScopeRecord): ScopeNodeSnapshot {
    const registrations = [...record.registrations]
      .filter(registration => registration.status === 'registered')
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(registration => ({
        id: String(registration.id),
        kind: registration.kind,
        name: registration.name,
        label: registration.label,
        ordinal: registration.ordinal,
      }))
    const children = [...record.children]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(child => String(child.id))
    return {
      id: String(record.id),
      label: record.label,
      status: record.status,
      ...(record.parent === undefined ? {} : { parent: String(record.parent.id) }),
      children,
      registrations,
      ownInFlight: record.tasks.size,
    }
  }

  #assertAccepting(scope: ScopeRecord, operation: string): void {
    if (scope.status !== 'accepting') {
      throw new ScopeInactiveError(String(scope.id), scope.label, scope.status, operation)
    }
  }

  #assertAcceptingOrStaging(scope: ScopeRecord, operation: string): void {
    if (scope.status === 'accepting' || scope.status === 'staging') return
    throw new ScopeInactiveError(String(scope.id), scope.label, scope.status, operation)
  }

  #assertInvocationAllowed(scope: ScopeRecord, operation: string): void {
    if (scope.status === 'staging') {
      throw new ScopeNotPublishedError(String(scope.id), scope.label, operation)
    }
    this.#assertAccepting(scope, operation)
  }

  #scheduleBarrierCheck(): void {
    if (this.#barrierCheckScheduled) return
    this.#barrierCheckScheduled = true
    queueMicrotask(() => {
      this.#barrierCheckScheduled = false
      for (const barrier of [...this.#barriers]) {
        if (this.#subtreeInFlight(barrier.scope) !== 0) continue
        this.#barriers.delete(barrier)
        barrier.resolve(this.snapshot(barrier.scope))
      }
    })
  }

  #subtreeInFlight(scope: ScopeRecord): number {
    return collectSubtree(scope)
      .reduce((total, record) => total + record.tasks.size, 0)
  }

  #touch(): void {
    this.#revision += 1
    this.#scheduleBarrierCheck()
  }
}

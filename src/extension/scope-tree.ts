import { AsyncLocalStorage } from 'node:async_hooks'
import type { Awaitable } from '../effect/index.js'
import {
  EventListenersFailedError,
  EventNameConflictError,
  MiddlewareNameConflictError,
  MiddlewareNextInactiveError,
  MiddlewareNextRepeatedError,
  MiddlewareUnterminatedError,
  ScopeInactiveError,
  ScopeNotPublishedError,
  ScopeReentrantWaitError,
} from './errors.js'
import type {
  EventListener,
  EventListenerFailure,
  EventName,
  MiddlewareHandler,
  MiddlewareName,
  MiddlewareNext,
  RegistrationHandle,
  RegistrationId,
  RegistrationStatus,
  RootScope,
  Scope,
  ScopeId,
  ScopeNodeSnapshot,
  ScopeSnapshot,
  ScopeStatus,
} from './types.js'

type RegistrationKind = 'listener' | 'middleware'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

interface NameEntry {
  readonly token: object
  readonly registrations: Set<RegistrationRecord>
}

interface StagedNames {
  readonly events: Map<string, NameEntry>
  readonly middleware: Map<string, NameEntry>
}

interface ScopeRecord {
  readonly id: ScopeId
  readonly ordinal: number
  readonly label: string
  status: ScopeStatus
  readonly parent: ScopeRecord | undefined
  readonly children: Set<ScopeRecord>
  readonly abort: AbortController
  readonly registrations: Set<RegistrationRecord>
  readonly tasks: Set<TaskRecord>
  stagingRoot: ScopeRecord | undefined
  stagedNames: StagedNames | undefined
  disposalTask: Promise<void> | undefined
}

interface RegistrationRecord {
  readonly id: RegistrationId
  readonly ordinal: number
  readonly kind: RegistrationKind
  readonly token: object
  readonly name: string
  readonly label: string
  readonly callback: EventListener<unknown> | MiddlewareHandler<unknown, unknown>
  readonly scope: ScopeRecord
  status: RegistrationStatus
  published: boolean
  disposalTask: Promise<void> | undefined
}

interface TaskRecord {
  readonly token: number
  readonly kind: 'origin' | 'frame'
  readonly owner: ScopeRecord
  readonly registration: RegistrationRecord | undefined
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
}

interface OriginTaskRecord extends TaskRecord {
  readonly kind: 'origin'
  readonly pendingContinuations: Set<Promise<unknown>>
  mainSettled: boolean
}

interface PendingBarrier {
  readonly scope: ScopeRecord
  readonly resolve: (snapshot: ScopeSnapshot) => void
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

const executionContext = new AsyncLocalStorage<ReadonlySet<number>>()
let nextTaskToken = 1

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function requireLabel(label: string, kind: string): string {
  if (label.length === 0) throw new TypeError(`${kind} label must not be empty`)
  return label
}

function nameTable(names: StagedNames, kind: RegistrationKind): Map<string, NameEntry> {
  return kind === 'listener' ? names.events : names.middleware
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

/**
 * Private runtime tree that owns scopes, registrations, executions, and barriers.
 *
 * CapabilityRegistry owns one instance. The class is exported only for focused internal
 * tests and is not re-exported from the package entry point.
 */
export class ScopeTree {
  readonly root: RootScope
  readonly #rootRecord: ScopeRecord
  readonly #registrations = new Map<number, RegistrationRecord>()
  readonly #activeEventNames = new Map<string, NameEntry>()
  readonly #activeMiddlewareNames = new Map<string, NameEntry>()
  readonly #activeTasks = new Map<number, TaskRecord>()
  readonly #barriers = new Set<PendingBarrier>()
  #barrierCheckScheduled = false
  #revision = 0
  #nextScopeId = 1
  #nextScopeOrdinal = 1
  #nextRegistrationId = 0
  #nextRegistrationOrdinal = 0

  constructor() {
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
    requireLabel(label, 'scope')
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
    return this.#register(
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
    return this.#register(
      scope,
      'middleware',
      name,
      label,
      handler as unknown as MiddlewareHandler<unknown, unknown>,
    )
  }

  derive(parent: ScopeRecord, label: string): Scope {
    requireLabel(label, 'scope')
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
    this.#assertInvocationName('listener', event, scope, 'emit()')
    const upperBound = this.#nextRegistrationOrdinal
    const origin = this.#createOrigin(scope)
    return this.#runOrigin(origin, async () => {
      let cursor = 0
      let attempted = 0
      const failures: EventListenerFailure[] = []
      for (;;) {
        const registration = this.#nextRegistration('listener', event, cursor, upperBound)
        if (registration === undefined) break
        cursor = registration.ordinal
        attempted += 1
        try {
          await this.#runFrame(registration, () =>
            (registration.callback as EventListener<TPayload>)(payload))
        } catch (reason) {
          failures.push({
            registrationId: registration.id,
            scopeId: registration.scope.id,
            listenerLabel: registration.label,
            reason,
          })
        }
      }
      if (failures.length > 0) {
        throw new EventListenersFailedError(event.name, attempted, failures)
      }
    })
  }

  invoke<TRequest, TResult>(
    scope: ScopeRecord,
    name: MiddlewareName<TRequest, TResult>,
    request: TRequest,
    terminal: ((request: TRequest) => Awaitable<TResult>) | undefined,
  ): Promise<TResult> {
    this.#assertInvocationAllowed(scope, 'invoke()')
    this.#assertInvocationName('middleware', name, scope, 'invoke()')
    const upperBound = this.#nextRegistrationOrdinal
    const origin = this.#createOrigin(scope)
    return this.#runOrigin(origin, () => this.#runWaterfall(
      origin,
      scope,
      name,
      request,
      terminal,
      0,
      upperBound,
    ))
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
    const scopes = this.#collectSubtree(scope)
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

    const subtree = this.#collectSubtree(scope)
    for (const record of subtree) {
      if (record.status === 'disposed' || record.status === 'disposing') continue
      record.status = 'disposing'
      record.abort.abort(new Error(`scope "${record.label}" is disposing`))
      for (const registration of [...record.registrations]) this.#disposeRegistration(registration)
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
    const nodes = this.#collectSubtree(root).filter(record => record.status === 'staging')
    const registrations = nodes
      .flatMap(record => [...record.registrations])
      .filter(registration => registration.status === 'registered')
      .sort((left, right) => left.ordinal - right.ordinal)

    for (const registration of registrations) {
      this.#assertActiveNameAvailable(
        registration.kind,
        registration.name,
        registration.token,
        registration.scope,
        'publish',
      )
    }

    return {
      apply: () => {
        for (const registration of registrations) this.#publishRegistration(registration)
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
    const inherited = executionContext.getStore()
    if (inherited === undefined) return undefined
    const active = [...inherited]
      .map(token => this.#activeTasks.get(token))
      .filter((task): task is TaskRecord => task !== undefined && this.#isWithin(task.owner, scope))
    if (active.length === 0) return undefined
    const activeScopeIds = [...new Set(active.map(task => String(task.owner.id)))]
    const registration = active.find(task => task.registration !== undefined)?.registration
    return new ScopeReentrantWaitError(
      String(scope.id),
      operation,
      activeScopeIds,
      registration === undefined ? undefined : String(registration.id),
    )
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

  #register(
    scope: ScopeRecord,
    kind: RegistrationKind,
    token: { readonly name: string },
    label: string,
    callback: EventListener<unknown> | MiddlewareHandler<unknown, unknown>,
  ): RegistrationHandle {
    requireLabel(label, kind === 'listener' ? 'listener' : 'middleware handler')
    this.#assertAcceptingOrStaging(scope, kind === 'listener' ? 'on()' : 'intercept()')
    this.#assertNameAvailable(kind, token, scope)
    this.#nextRegistrationId += 1
    this.#nextRegistrationOrdinal += 1
    const record: RegistrationRecord = {
      id: `r${this.#nextRegistrationId}` as RegistrationId,
      ordinal: this.#nextRegistrationOrdinal,
      kind,
      token,
      name: token.name,
      label,
      callback,
      scope,
      status: 'registered',
      published: scope.status === 'accepting',
      disposalTask: undefined,
    }
    scope.registrations.add(record)
    if (record.published) {
      this.#registrations.set(record.ordinal, record)
      this.#addName(this.#activeNames(kind), record)
    } else {
      const stagingRoot = scope.stagingRoot
      const names = stagingRoot?.stagedNames
      if (names === undefined) throw new Error('staging scope has no name ledger')
      this.#addName(nameTable(names, kind), record)
    }
    this.#touch()
    return this.#createRegistrationHandle(record)
  }

  #createRegistrationHandle(record: RegistrationRecord): RegistrationHandle {
    return {
      id: record.id,
      scopeId: record.scope.id,
      label: record.label,
      get status(): RegistrationStatus { return record.status },
      dispose: () => this.#disposeRegistration(record),
    }
  }

  #disposeRegistration(record: RegistrationRecord): Promise<void> {
    if (record.disposalTask !== undefined) return record.disposalTask
    if (record.status === 'registered') {
      record.status = 'disposed'
      record.scope.registrations.delete(record)
      if (record.published) {
        this.#registrations.delete(record.ordinal)
        this.#removeName(this.#activeNames(record.kind), record)
      } else {
        const names = record.scope.stagingRoot?.stagedNames
        if (names !== undefined) this.#removeName(nameTable(names, record.kind), record)
      }
      this.#touch()
    }
    record.disposalTask = Promise.resolve()
    return record.disposalTask
  }

  #publishRegistration(record: RegistrationRecord): void {
    record.published = true
    this.#registrations.set(record.ordinal, record)
    this.#addName(this.#activeNames(record.kind), record)
    this.#touch()
  }

  #assertNameAvailable(
    kind: RegistrationKind,
    token: { readonly name: string },
    scope: ScopeRecord,
  ): void {
    this.#assertActiveNameAvailable(kind, token.name, token, scope, 'register')
    const stagedNames = scope.stagingRoot?.stagedNames
    if (stagedNames === undefined) return
    const entry = nameTable(stagedNames, kind).get(token.name)
    if (entry !== undefined && entry.token !== token) {
      this.#throwNameConflict(kind, token.name, entry, scope, 'register')
    }
  }

  #assertInvocationName(
    kind: RegistrationKind,
    token: { readonly name: string },
    scope: ScopeRecord,
    operation: string,
  ): void {
    this.#assertActiveNameAvailable(kind, token.name, token, scope, operation)
  }

  #assertActiveNameAvailable(
    kind: RegistrationKind,
    name: string,
    token: object,
    scope: ScopeRecord,
    operation: string,
  ): void {
    const entry = this.#activeNames(kind).get(name)
    if (entry !== undefined && entry.token !== token) {
      this.#throwNameConflict(kind, name, entry, scope, operation)
    }
  }

  #throwNameConflict(
    kind: RegistrationKind,
    name: string,
    entry: NameEntry,
    scope: ScopeRecord,
    operation: string,
  ): never {
    const existing = [...entry.registrations]
      .sort((left, right) => left.ordinal - right.ordinal)[0]
    const existingScopeId = existing === undefined ? String(scope.id) : String(existing.scope.id)
    if (kind === 'listener') {
      throw new EventNameConflictError(name, existingScopeId, String(scope.id), operation)
    }
    throw new MiddlewareNameConflictError(name, existingScopeId, String(scope.id), operation)
  }

  #activeNames(kind: RegistrationKind): Map<string, NameEntry> {
    return kind === 'listener' ? this.#activeEventNames : this.#activeMiddlewareNames
  }

  #addName(table: Map<string, NameEntry>, registration: RegistrationRecord): void {
    const entry = table.get(registration.name)
    if (entry === undefined) {
      table.set(registration.name, { token: registration.token, registrations: new Set([registration]) })
      return
    }
    entry.registrations.add(registration)
  }

  #removeName(table: Map<string, NameEntry>, registration: RegistrationRecord): void {
    const entry = table.get(registration.name)
    if (entry === undefined) return
    entry.registrations.delete(registration)
    if (entry.registrations.size === 0) table.delete(registration.name)
  }

  #nextRegistration(
    kind: RegistrationKind,
    token: object,
    cursor: number,
    upperBound: number,
  ): RegistrationRecord | undefined {
    let found: RegistrationRecord | undefined
    for (const registration of this.#registrations.values()) {
      if (registration.kind !== kind || registration.token !== token) continue
      if (registration.ordinal <= cursor || registration.ordinal > upperBound) continue
      if (registration.status !== 'registered' || !registration.published) continue
      if (registration.scope.status !== 'accepting') continue
      if (found === undefined || registration.ordinal < found.ordinal) found = registration
    }
    return found
  }

  async #runWaterfall<TRequest, TResult>(
    origin: OriginTaskRecord,
    originScope: ScopeRecord,
    name: MiddlewareName<TRequest, TResult>,
    request: TRequest,
    terminal: ((request: TRequest) => Awaitable<TResult>) | undefined,
    cursor: number,
    upperBound: number,
  ): Promise<TResult> {
    const registration = this.#nextRegistration('middleware', name, cursor, upperBound)
    if (registration === undefined) {
      if (terminal === undefined) {
        throw new MiddlewareUnterminatedError(name.name, String(originScope.id))
      }
      return await terminal(request)
    }

    let open = true
    let called = false
    const next = ((...args: [] | [TRequest]): Promise<TResult> => {
      if (called) {
        return Promise.reject(new MiddlewareNextRepeatedError(
          name.name,
          String(registration.id),
          String(registration.scope.id),
          registration.label,
        ))
      }
      if (!open) {
        return Promise.reject(new MiddlewareNextInactiveError(
          name.name,
          String(registration.id),
          String(registration.scope.id),
          registration.label,
        ))
      }
      called = true
      return this.#startContinuation(origin, () => this.#runWaterfall(
        origin,
        originScope,
        name,
        args.length === 0 ? request : args[0],
        terminal,
        registration.ordinal,
        upperBound,
      ))
    }) as MiddlewareNext<TRequest, TResult>

    try {
      return await this.#runFrame(registration, () =>
        (registration.callback as MiddlewareHandler<TRequest, TResult>)(request, next))
    } finally {
      open = false
    }
  }

  #createOrigin(owner: ScopeRecord): OriginTaskRecord {
    const completion = deferred<void>()
    const origin: OriginTaskRecord = {
      token: nextTaskToken,
      kind: 'origin',
      owner,
      registration: undefined,
      settled: completion.promise,
      resolveSettled: () => completion.resolve(undefined),
      pendingContinuations: new Set(),
      mainSettled: false,
    }
    nextTaskToken += 1
    this.#admitTask(origin)
    return origin
  }

  #runOrigin<T>(origin: OriginTaskRecord, operation: () => Awaitable<T>): Promise<T> {
    const task = this.#callUnderTask(origin, operation)
    void task.then(
      () => {
        origin.mainSettled = true
        this.#finishOriginIfSettled(origin)
      },
      () => {
        origin.mainSettled = true
        this.#finishOriginIfSettled(origin)
      },
    )
    return task
  }

  #runFrame<T>(registration: RegistrationRecord, operation: () => Awaitable<T>): Promise<T> {
    const frame = this.#createTask(registration.scope, 'frame', registration)
    const task = this.#callUnderTask(frame, operation)
    void task.then(
      () => this.#finishTask(frame),
      () => this.#finishTask(frame),
    )
    return task
  }

  #callUnderTask<T>(task: TaskRecord, operation: () => Awaitable<T>): Promise<T> {
    const inherited = new Set(executionContext.getStore())
    inherited.add(task.token)
    try {
      return Promise.resolve(executionContext.run(inherited, operation))
    } catch (reason) {
      return Promise.reject(reason)
    }
  }

  #createTask(
    owner: ScopeRecord,
    kind: 'origin' | 'frame',
    registration: RegistrationRecord | undefined,
  ): TaskRecord {
    const completion = deferred<void>()
    const task: TaskRecord = {
      token: nextTaskToken,
      kind,
      owner,
      registration,
      settled: completion.promise,
      resolveSettled: () => completion.resolve(undefined),
    }
    nextTaskToken += 1
    this.#admitTask(task)
    return task
  }

  #admitTask(task: TaskRecord): void {
    task.owner.tasks.add(task)
    this.#activeTasks.set(task.token, task)
    this.#touch()
  }

  #startContinuation<T>(
    origin: OriginTaskRecord,
    operation: () => Promise<T>,
  ): Promise<T> {
    let resolveContinuation!: (value: T | PromiseLike<T>) => void
    let rejectContinuation!: (reason?: unknown) => void
    const continuation = new Promise<T>((resolve, reject) => {
      resolveContinuation = resolve
      rejectContinuation = reject
    })
    origin.pendingContinuations.add(continuation)
    void continuation.then(
      () => {
        origin.pendingContinuations.delete(continuation)
        this.#finishOriginIfSettled(origin)
      },
      () => {
        origin.pendingContinuations.delete(continuation)
        this.#finishOriginIfSettled(origin)
      },
    )
    try {
      void operation().then(resolveContinuation, rejectContinuation)
    } catch (reason) {
      rejectContinuation(reason)
    }
    return continuation
  }

  #finishOriginIfSettled(origin: OriginTaskRecord): void {
    if (origin.mainSettled && origin.pendingContinuations.size === 0) this.#finishTask(origin)
  }

  #finishTask(task: TaskRecord): void {
    if (!this.#activeTasks.delete(task.token)) return
    task.owner.tasks.delete(task)
    task.resolveSettled()
    this.#touch()
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

  #collectSubtree(root: ScopeRecord): ScopeRecord[] {
    const records: ScopeRecord[] = []
    const visit = (record: ScopeRecord): void => {
      records.push(record)
      for (const child of record.children) visit(child)
    }
    visit(root)
    return records
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

  #isWithin(candidate: ScopeRecord, target: ScopeRecord): boolean {
    for (let current: ScopeRecord | undefined = candidate; current !== undefined; current = current.parent) {
      if (current === target) return true
    }
    return false
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
    return this.#collectSubtree(scope)
      .reduce((total, record) => total + record.tasks.size, 0)
  }

  #touch(): void {
    this.#revision += 1
    this.#scheduleBarrierCheck()
  }
}

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Awaitable } from '../effect/index.js'
import { ScopeReentrantWaitError } from './errors.js'
import { isWithin } from './records.js'
import type {
  OriginTaskRecord,
  RegistrationRecord,
  ScopeRecord,
  TaskRecord,
} from './records.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
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

/** Owns execution tokens and the in-flight task sets attached to Scope records. */
export class TaskTracker {
  readonly #active = new Map<number, TaskRecord>()

  constructor(private readonly onChange: () => void) {}

  /** Return the wait-cycle error implied by the current asynchronous task chain. */
  reentrantError(scope: ScopeRecord, operation: string): ScopeReentrantWaitError | undefined {
    const inherited = executionContext.getStore()
    if (inherited === undefined) return undefined
    const active = [...inherited]
      .map(token => this.#active.get(token))
      .filter((task): task is TaskRecord => task !== undefined && isWithin(task.owner, scope))
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

  /** Run an invocation as one Origin Task owned by its initiating Scope. */
  runOrigin<T>(
    owner: ScopeRecord,
    operation: (origin: OriginTaskRecord) => Awaitable<T>,
  ): Promise<T> {
    const origin = this.#createOrigin(owner)
    const task = this.#callUnderTask(origin, () => operation(origin))
    const settleMain = (): void => {
      origin.mainSettled = true
      this.#finishOriginIfSettled(origin)
    }
    void task.then(settleMain, settleMain)
    return task
  }

  /** Run one callback as a Frame owned by its registration Scope. */
  runFrame<T>(registration: RegistrationRecord, operation: () => Awaitable<T>): Promise<T> {
    const frame = this.#createFrame(registration)
    const task = this.#callUnderTask(frame, operation)
    const finish = (): void => this.#finishTask(frame)
    void task.then(finish, finish)
    return task
  }

  /** Keep a delegated middleware branch attached to its Origin Task until it settles. */
  startContinuation<T>(
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
    const finish = (): void => {
      origin.pendingContinuations.delete(continuation)
      this.#finishOriginIfSettled(origin)
    }
    void continuation.then(finish, finish)
    try {
      void operation().then(resolveContinuation, rejectContinuation)
    } catch (reason) {
      rejectContinuation(reason)
    }
    return continuation
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
    this.#admit(origin)
    return origin
  }

  #createFrame(registration: RegistrationRecord): TaskRecord {
    const completion = deferred<void>()
    const task: TaskRecord = {
      token: nextTaskToken,
      kind: 'frame',
      owner: registration.scope,
      registration,
      settled: completion.promise,
      resolveSettled: () => completion.resolve(undefined),
    }
    nextTaskToken += 1
    this.#admit(task)
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

  #admit(task: TaskRecord): void {
    task.owner.tasks.add(task)
    this.#active.set(task.token, task)
    this.onChange()
  }

  #finishOriginIfSettled(origin: OriginTaskRecord): void {
    if (origin.mainSettled && origin.pendingContinuations.size === 0) this.#finishTask(origin)
  }

  #finishTask(task: TaskRecord): void {
    if (!this.#active.delete(task.token)) return
    task.owner.tasks.delete(task)
    task.resolveSettled()
    this.onChange()
  }
}

import type { Awaitable } from '../../effect/types.js'
import type { ModelExchange, ModelFrame } from '../contract.js'
import { ModelError } from '../errors.js'
import { inheritsModelTask, inModelTask } from '../task-context.js'
import type { ExchangeTicket } from './capacity.js'

export interface ExchangeOperations {
  readonly open: (signal: AbortSignal) => Awaitable<AsyncIterable<ModelFrame>>
  readonly release: () => Awaitable<void>
  readonly assertActive: () => void
}

/** Owns start-once, pull admission, in-flight I/O and the single shared close task. */
export class ManagedModelExchange implements ModelExchange {
  readonly #operations: ExchangeOperations
  readonly #ticket: ExchangeTicket
  readonly #abort = new AbortController()
  readonly #parent: AbortSignal
  readonly #cancel: () => void
  readonly #closeToken = Symbol('model exchange close')
  #startTask: Promise<AsyncIterable<ModelFrame>> | undefined
  #iterator: AsyncIterator<ModelFrame> | undefined
  #readTask: Promise<IteratorResult<ModelFrame>> | undefined
  #closeTask: Promise<void> | undefined
  #done = false
  #closed = false

  constructor(operations: ExchangeOperations, parent: AbortSignal, ticket: ExchangeTicket) {
    this.#operations = operations
    this.#ticket = ticket
    this.#parent = parent
    this.#cancel = () => this.#abort.abort()
    parent.addEventListener('abort', this.#cancel, { once: true })
    if (parent.aborted) this.#cancel()
  }

  start(): Promise<AsyncIterable<ModelFrame>> {
    if (this.#startTask !== undefined || this.#closeTask !== undefined) throw new ModelError('MODEL_STATE_INVALID', 'model exchange may start exactly once while open')
    this.#operations.assertActive()
    if (this.#abort.signal.aborted) throw new ModelError('MODEL_CALL_CANCELLED', 'model exchange was cancelled before start')
    const task = inModelTask(this.#ticket.token, () => Promise.resolve().then(async () => {
      const stream = await this.#operations.open(this.#abort.signal)
      this.#iterator = stream[Symbol.asyncIterator]()
      const iterator: AsyncIterableIterator<ModelFrame> = {
        next: () => this.#next(),
        [Symbol.asyncIterator]() { return this },
      }
      // Resource closure belongs to close(), not to the consumer's iterator.return().
      return iterator
    }))
    this.#startTask = task
    void task.catch(() => undefined)
    return task
  }

  close(): Promise<void> {
    if (this.#closeTask === undefined) {
      const task = inModelTask(this.#ticket.token, () => inModelTask(this.#closeToken, () => Promise.resolve().then(() => this.#finishClose())))
      this.#closeTask = task
      void task.catch(() => undefined)
      this.#abort.abort()
    }
    if (!this.#closed && (inheritsModelTask(this.#closeToken) || inheritsModelTask(this.#ticket.token))) return Promise.reject(new ModelError('MODEL_REENTRANT_WAIT', 'model exchange close cannot await its own cleanup'))
    return this.#closeTask
  }

  #next(): Promise<IteratorResult<ModelFrame>> {
    if (this.#closeTask !== undefined) return Promise.reject(new ModelError('MODEL_PROVIDER_INACTIVE', 'model exchange is closing'))
    if (this.#readTask !== undefined) return Promise.reject(new ModelError('MODEL_STATE_INVALID', 'model exchange supports only serial pulls'))
    if (this.#done) return Promise.resolve({ done: true, value: undefined })
    const iterator = this.#iterator
    if (iterator === undefined) return Promise.reject(new ModelError('MODEL_STATE_INVALID', 'model exchange has not started'))
    const task = inModelTask(this.#ticket.token, () => Promise.resolve().then(() => iterator.next()))
    this.#readTask = task
    void task.then(
      result => { this.#readTask = undefined; if (result.done) this.#done = true },
      () => { this.#readTask = undefined },
    )
    return task
  }

  async #finishClose(): Promise<void> {
    let failures = 0
    try {
      // Rejected start/read belong to generation. Still await them before releasing.
      if (this.#startTask !== undefined) await this.#startTask.catch(() => undefined)
      if (this.#readTask !== undefined) await this.#readTask.catch(() => undefined)
      if (!this.#done && this.#iterator?.return !== undefined) {
        try { await this.#iterator.return() }
        catch { failures += 1 }
      }
      try { await this.#operations.release() }
      catch { failures += 1 }
    } finally {
      this.#parent.removeEventListener('abort', this.#cancel)
      this.#closed = true
    }
    const failure = failures === 0 ? undefined : new ModelError('MODEL_CLEANUP_FAILED', 'model exchange cleanup is incomplete', { failedResources: failures })
    this.#ticket.settle(failure)
    if (failure !== undefined) throw failure
  }
}

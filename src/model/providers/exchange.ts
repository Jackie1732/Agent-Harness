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

interface ExchangeRuntime {
  readonly operations: ExchangeOperations
  readonly ticket: ExchangeTicket
  readonly abort: AbortController
  readonly parent: AbortSignal
  readonly cancel: () => void
}

/** Owns start-once, serial pulls and shared close; settled cleanup retires request borrows. */
export class ManagedModelExchange implements ModelExchange {
  #runtime: ExchangeRuntime | undefined
  readonly #ticketToken: symbol
  readonly #closeToken = Symbol('model exchange close')
  #startTask: Promise<AsyncIterable<ModelFrame>> | undefined
  #iterator: AsyncIterator<ModelFrame> | undefined
  #readTask: Promise<IteratorResult<ModelFrame>> | undefined
  #closeTask: Promise<void> | undefined
  #done = false
  #closed = false

  constructor(operations: ExchangeOperations, parent: AbortSignal, ticket: ExchangeTicket) {
    const abort = new AbortController()
    const cancel = (): void => abort.abort()
    this.#runtime = { operations, ticket, abort, parent, cancel }
    this.#ticketToken = ticket.token
    parent.addEventListener('abort', cancel, { once: true })
    if (parent.aborted) cancel()
  }

  start(): Promise<AsyncIterable<ModelFrame>> {
    if (this.#startTask !== undefined || this.#closeTask !== undefined) throw new ModelError('MODEL_STATE_INVALID', 'model exchange may start exactly once while open')
    const runtime = this.#runtime!
    runtime.operations.assertActive()
    if (runtime.abort.signal.aborted) throw new ModelError('MODEL_CALL_CANCELLED', 'model exchange was cancelled before start')
    const task = inModelTask(this.#ticketToken, () => Promise.resolve().then(async () => {
      const stream = await runtime.operations.open(runtime.abort.signal)
      this.#iterator = stream[Symbol.asyncIterator]()
      // Resource closure belongs to close(), not to the consumer's iterator.return().
      return this.#stream()
    }))
    this.#startTask = task
    void task.catch(() => undefined)
    return task
  }

  close(): Promise<void> {
    if (this.#closeTask === undefined) {
      const runtime = this.#runtime!
      const task = inModelTask(this.#ticketToken, () => inModelTask(this.#closeToken, () => Promise.resolve().then(() => this.#finishClose(runtime))))
      this.#closeTask = task
      void task.catch(() => undefined)
      runtime.abort.abort()
    }
    if (!this.#closed && (inheritsModelTask(this.#closeToken) || inheritsModelTask(this.#ticketToken))) return Promise.reject(new ModelError('MODEL_REENTRANT_WAIT', 'model exchange close cannot await its own cleanup'))
    return this.#closeTask
  }

  #next(): Promise<IteratorResult<ModelFrame>> {
    if (this.#closeTask !== undefined) return Promise.reject(new ModelError('MODEL_PROVIDER_INACTIVE', 'model exchange is closing'))
    if (this.#readTask !== undefined) return Promise.reject(new ModelError('MODEL_STATE_INVALID', 'model exchange supports only serial pulls'))
    if (this.#done) return Promise.resolve({ done: true, value: undefined })
    const iterator = this.#iterator
    if (iterator === undefined) return Promise.reject(new ModelError('MODEL_STATE_INVALID', 'model exchange has not started'))
    const task = inModelTask(this.#ticketToken, () => Promise.resolve().then(() => iterator.next()))
    this.#readTask = task
    void task.then(
      result => { this.#readTask = undefined; if (result.done) this.#done = true },
      () => { this.#readTask = undefined },
    )
    return task
  }

  #stream(): AsyncIterableIterator<ModelFrame> {
    return {
      next: () => this.#next(),
      [Symbol.asyncIterator]() { return this },
    }
  }

  async #finishClose(runtime: ExchangeRuntime): Promise<void> {
    let failures = 0
    try {
      // Rejected start/read belong to generation. Still await them before releasing.
      if (this.#startTask !== undefined) await this.#startTask.catch(() => undefined)
      if (this.#readTask !== undefined) await this.#readTask.catch(() => undefined)
      if (!this.#done && this.#iterator?.return !== undefined) {
        try { await this.#iterator.return() }
        catch { failures += 1 }
      }
      try { await runtime.operations.release() }
      catch { failures += 1 }
    } finally {
      runtime.parent.removeEventListener('abort', runtime.cancel)
      this.#runtime = undefined
      this.#startTask = undefined
      this.#readTask = undefined
      this.#iterator = undefined
      this.#closed = true
    }
    const failure = failures === 0 ? undefined : new ModelError('MODEL_CLEANUP_FAILED', 'model exchange cleanup is incomplete', { failedResources: failures })
    runtime.ticket.settle(failure)
    if (failure !== undefined) throw failure
  }
}

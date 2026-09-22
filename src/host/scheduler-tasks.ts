/** Tracks accepted lane work through failure and cooperative cancellation. */
export class HostSchedulerTasks {
  readonly #stop = new AbortController()
  readonly #pending = new Set<Promise<void>>()
  readonly #failures = new Set<unknown>()
  readonly signal: AbortSignal

  constructor(signal: AbortSignal) { this.signal = AbortSignal.any([signal, this.#stop.signal]) }

  get pending(): readonly Promise<void>[] { return [...this.#pending] }

  run(operation: () => Promise<void>): Promise<void> {
    const task = Promise.resolve().then(operation)
    this.#pending.add(task)
    void task.then(() => this.#pending.delete(task), cause => {
      this.#failures.add(cause)
      this.#stop.abort()
      this.#pending.delete(task)
    })
    return task
  }

  fail(cause: unknown): void { this.#failures.add(cause); this.#stop.abort() }

  async join(): Promise<void> {
    await Promise.allSettled(this.#pending)
    if (this.#failures.size === 1) throw this.#failures.values().next().value
    if (this.#failures.size > 1) throw new AggregateError([...this.#failures], 'Host scheduler failed')
  }
}

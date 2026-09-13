/** FIFO critical section used to publish one committed storage boundary at a time. */
export class SerialGate {
  #tail: Promise<void> = Promise.resolve()

  /** Run one task after every previously accepted task has settled. */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(task, task)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

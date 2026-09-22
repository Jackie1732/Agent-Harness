import { HostError } from './errors.js'

interface ObserverGroup {
  readonly stop: AbortController
  readonly pending: Set<Promise<unknown>>
}

/** Observers share Host task accounting; each parent generation has its own stop and join boundary. */
export class HostObservationTasks {
  readonly #stop = new AbortController()
  readonly #parents = new Map<string, ObserverGroup>()

  bind(parentKey: string, track: <T>(task: () => Promise<T>) => Promise<T>) {
    this.#stop.signal.throwIfAborted()
    let group = this.#parents.get(parentKey)
    if (group === undefined) {
      group = { stop: new AbortController(), pending: new Set() }
      this.#parents.set(parentKey, group)
    }
    const owner = group
    const signal = AbortSignal.any([this.#stop.signal, owner.stop.signal])
    return {
      stopSignal: signal,
      trackObservation<T>(operation: () => Promise<T>): Promise<T> {
        signal.throwIfAborted()
        const task = track(operation)
        owner.pending.add(task)
        void task.then(() => owner.pending.delete(task), () => owner.pending.delete(task))
        return task
      },
    }
  }

  closeParent(parentKey: string): Promise<void> {
    const group = this.#parents.get(parentKey)
    if (group === undefined) return Promise.resolve()
    this.#parents.delete(parentKey)
    group.stop.abort(new HostError('HOST_NOT_READY', 'parent-mailbox-offline'))
    return Promise.allSettled(group.pending).then(() => undefined)
  }

  /** Host shutdown publishes its shared task before waking observers, then joins them through normal task accounting. */
  close(): void { this.#stop.abort(new HostError('HOST_INACTIVE', 'host-stopping')) }
}

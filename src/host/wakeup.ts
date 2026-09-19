/** Coalesce scheduling hints into one wake generation; persisted facts remain authoritative. */
export class HostWakeup {
  #controller = new AbortController()
  #pending = false

  notify(): void {
    this.#pending = true
    this.#controller.abort()
  }

  /** Consume prior hints before scanning; hints arriving during the scan wake its following wait. */
  scan(): AbortSignal {
    if (this.#pending) { this.#controller = new AbortController(); this.#pending = false }
    return this.#controller.signal
  }
}

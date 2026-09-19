/** Monotonic intervals and cancellable wakes are independent from the durable UTC clock. */
export interface HostTimer {
  now(): number
  wait(milliseconds: number, signal: AbortSignal): Promise<void>
}

export const nodeHostTimer: HostTimer = Object.freeze({
  now: () => performance.now(),
  wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(done, Math.max(1, Math.min(milliseconds, 2_147_483_647)))
      function done(): void {
        clearTimeout(timer); signal.removeEventListener('abort', done); resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })
  },
})

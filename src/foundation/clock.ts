/** Wall-clock source expressed as Unix epoch milliseconds. */
export interface Clock {
  now(): number
}

/** Process wall clock used outside deterministic tests. */
export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
})

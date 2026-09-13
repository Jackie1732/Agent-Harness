/** Wall-clock source expressed as Unix epoch milliseconds. */
export interface Clock {
  /** @returns Current Unix epoch time in milliseconds. */
  now(): number
}

/** Process wall clock used outside deterministic tests. */
export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
})

/** Convert one finite Clock reading to canonical UTC text. */
export function clockTimestamp(clock: Clock): string {
  const value = clock.now()
  if (!Number.isFinite(value)) throw new TypeError('Clock must return a finite epoch millisecond value')
  return new Date(value).toISOString()
}

/** Reject a discriminated-union member that compile-time exhaustiveness should exclude. */
export function assertNever(value: never, label: string): never {
  throw new TypeError(`unhandled ${label}: ${String(value)}`)
}

declare const brandSymbol: unique symbol

/** A compile-time distinction over an existing runtime representation. */
export type Brand<T, Name extends string> = T & {
  readonly [brandSymbol]: Name
}

/**
 * Apply a compile-time brand without changing the runtime value.
 *
 * The owning domain must validate the value before calling this helper when
 * the brand carries runtime constraints.
 */
export function brand<T, Name extends string>(value: T): Brand<T, Name> {
  return value as Brand<T, Name>
}

/** Remove a compile-time brand without changing the runtime value. */
export function unbrand<T>(value: Brand<T, string>): T {
  return value
}

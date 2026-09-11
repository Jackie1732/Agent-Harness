/** Successful expected outcome. */
export interface Ok<T> {
  readonly ok: true
  readonly value: T
}

/** Expected failure that a caller handles as data. */
export interface Err<E> {
  readonly ok: false
  readonly error: E
}

/** Expected outcome with an explicit success or failure branch. */
export type Result<T, E> = Ok<T> | Err<E>

/** Construct a successful expected outcome. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

/** Construct an expected failure. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error }
}

/** Narrow an expected outcome to its success branch. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok
}

/** Narrow an expected outcome to its failure branch. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok
}

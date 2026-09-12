import type { EventName, MiddlewareName } from './types.js'

function requireName(name: string, kind: string): string {
  if (name.length === 0) throw new TypeError(`${kind} name must not be empty`)
  return name
}

/**
 * Create the typed identity of one in-process event.
 *
 * @param name - Non-empty diagnostic name.
 * @returns A frozen identity token.
 */
export function createEventName<TPayload>(name: string): EventName<TPayload> {
  return Object.freeze({ name: requireName(name, 'event') }) as EventName<TPayload>
}

/**
 * Create the typed identity of one middleware chain.
 *
 * @param name - Non-empty diagnostic name.
 * @returns A frozen identity token.
 */
export function createMiddlewareName<TRequest, TResult>(
  name: string,
): MiddlewareName<TRequest, TResult> {
  return Object.freeze({ name: requireName(name, 'middleware') }) as MiddlewareName<TRequest, TResult>
}

import { AsyncLocalStorage } from 'node:async_hooks'

const context = new AsyncLocalStorage<ReadonlySet<symbol>>()
/** Inherited tokens are intersected with live tasks by each owner, never used as durable IDs. */
export function withToolTask<T>(token: symbol, operation: () => T): T {
  return context.run(new Set([...(context.getStore() ?? []), token]), operation)
}
export function ownsToolTask(token: symbol): boolean { return context.getStore()?.has(token) === true }

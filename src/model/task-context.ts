import { AsyncLocalStorage } from 'node:async_hooks'

// Inherited task identities are a wait-graph guard, not a global ownership registry.
const modelTasks = new AsyncLocalStorage<ReadonlySet<symbol>>()

export function inModelTask<T>(token: symbol, operation: () => T): T {
  const inherited = new Set(modelTasks.getStore())
  inherited.add(token)
  return modelTasks.run(inherited, operation)
}

export function inheritsModelTask(token: symbol): boolean {
  return modelTasks.getStore()?.has(token) === true
}

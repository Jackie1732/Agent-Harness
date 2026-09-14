import type { Awaitable } from '../../effect/types.js'
import type { PreparedToolCall, PreparedToolPlan, ToolExecution, ToolExecutionResult } from '../contract.js'
import { ToolError } from '../errors.js'
import { ownsToolTask, withToolTask } from '../execution-context.js'
import { equalJson } from '../validation.js'

interface Slot { readonly token: symbol; callbacks: number; readonly controller: AbortController; readonly closed: Promise<void>; readonly release: () => void }

async function inSlot<T>(slot: Slot, operation: () => Awaitable<T>): Promise<T> {
  slot.callbacks++
  try { return await withToolTask(slot.token, operation) } finally { slot.callbacks-- }
}

/** Provider capacity and fixed bindings only; invocation resources still have one Effect owner. */
export class ToolExecutionPool {
  readonly #slots = new Set<Slot>()
  readonly #capacity: number
  #retiring = false
  #closeTask: Promise<void> | undefined
  #cleanupFailed = false
  constructor(capacity: number) { this.#capacity = capacity }

  assertAccepting(): void {
    if (this.#retiring) throw new ToolError('TOOL_PROVIDER_INACTIVE', 'tool provider is retiring')
  }

  prepare(plan: PreparedToolPlan, acquire: (plan: PreparedToolPlan, signal: AbortSignal) => Awaitable<ToolExecution>): PreparedToolCall {
    this.assertAccepting()
    let acquired = false
    return Object.freeze({ plan, acquire: async (committed: PreparedToolPlan, signal: AbortSignal): Promise<ToolExecution> => {
      if (acquired || !equalJson(plan, committed)) throw new ToolError('TOOL_BINDING_MISMATCH', 'prepared tool binding is single-use and content-bound')
      acquired = true
      if (this.#retiring || signal.aborted) throw new ToolError('TOOL_PROVIDER_INACTIVE', 'tool binding is no longer active')
      if (this.#slots.size >= this.#capacity) throw new ToolError('TOOL_PROVIDER_BUSY', 'tool provider capacity is exhausted')
      const controller = new AbortController()
      let release!: () => void
      const closed = new Promise<void>(resolve => { release = resolve })
      const slot: Slot = { token: Symbol('provider execution'), callbacks: 0, controller, closed, release }
      this.#slots.add(slot)
      const combined = AbortSignal.any([signal, controller.signal])
      let inner: ToolExecution
      try { inner = await inSlot(slot, () => acquire(committed, combined)) }
      catch (reason) { this.#slots.delete(slot); release(); throw reason }
      let startTask: Promise<ToolExecutionResult> | undefined
      let closeTask: Promise<void> | undefined
      return Object.freeze({
        start: (): Promise<ToolExecutionResult> => {
          if (startTask !== undefined || closeTask !== undefined || combined.aborted) throw new ToolError('TOOL_PROVIDER_INACTIVE', 'execution cannot start again or after cancellation')
          // Publish the task before calling possibly reentrant implementation code.
          startTask = Promise.resolve().then(() => {
            if (combined.aborted) throw new ToolError('TOOL_CANCELLED', 'execution was cancelled before its body started')
            return inSlot(slot, () => inner.start())
          })
          void startTask.catch(() => undefined)
          return startTask
        },
        close: (): Promise<void> => {
          if (closeTask === undefined) {
            closeTask = Promise.resolve().then(async () => {
              if (startTask !== undefined) await startTask.catch(() => undefined)
              await inSlot(slot, () => inner.close())
            }).catch(() => {
              this.#cleanupFailed = true
              throw new ToolError('TOOL_CLEANUP_FAILED', 'tool execution did not close completely')
            }).finally(() => { this.#slots.delete(slot); release() })
            void closeTask.catch(() => undefined)
            controller.abort()
          }
          if (slot.callbacks > 0 && ownsToolTask(slot.token)) return Promise.reject(new ToolError('TOOL_REENTRANT_WAIT', 'execution cannot wait for its own close'))
          return closeTask
        },
      })
    } })
  }

  dispose(): Promise<void> {
    if (this.#closeTask === undefined) {
      this.#retiring = true
      const pending = [...this.#slots].map(slot => slot.closed)
      this.#closeTask = Promise.resolve().then(async () => {
        await Promise.all(pending)
        if (this.#cleanupFailed) throw new ToolError('TOOL_CLEANUP_FAILED', 'provider retains an incomplete execution cleanup')
      })
      void this.#closeTask.catch(() => undefined)
      for (const slot of this.#slots) slot.controller.abort()
    }
    if ([...this.#slots].some(slot => slot.callbacks > 0 && ownsToolTask(slot.token))) {
      return Promise.reject(new ToolError('TOOL_REENTRANT_WAIT', 'provider callback cannot wait for its own provider'))
    }
    return this.#closeTask
  }
}

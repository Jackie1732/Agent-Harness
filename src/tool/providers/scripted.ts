import type { Awaitable } from '../../effect/types.js'
import type { JsonValue } from '../../foundation/json.js'
import type { PreparedToolCall, PreparedToolPlan, ToolDefinition, ToolExecution, ToolExecutionResult, ToolInvocationLimits, ToolProvider, ToolProviderDescriptor } from '../contract.js'
import { createPreparedToolPlan } from '../plan.js'
import { readDescriptor } from '../validation.js'
import { ToolExecutionPool } from './pool.js'

export interface ScriptedToolProviderOptions {
  readonly descriptor: ToolProviderDescriptor
  /** Must be pure; use this only to observe/validate prepare, not to execute an operation. */
  readonly onPrepare?: (plan: PreparedToolPlan) => void
  /** Local managed acquisition; protected work belongs in returned start(). */
  readonly acquire: (plan: PreparedToolPlan, signal: AbortSignal) => Awaitable<ToolExecution>
}

/** Deterministic provider through the same schema, policy, journal, and ownership pipeline. */
export class ScriptedToolProvider implements ToolProvider {
  readonly descriptor: ToolProviderDescriptor
  readonly #pool: ToolExecutionPool
  #runtime: Pick<ScriptedToolProviderOptions, 'acquire' | 'onPrepare'> | undefined
  constructor(options: ScriptedToolProviderOptions) {
    this.descriptor = readDescriptor(options.descriptor)
    this.#pool = new ToolExecutionPool(this.descriptor.maxConcurrentExecutions)
    this.#runtime = { acquire: options.acquire, ...(options.onPrepare === undefined ? {} : { onPrepare: options.onPrepare }) }
  }
  prepare(definition: ToolDefinition, input: JsonValue, limits: ToolInvocationLimits): PreparedToolCall {
    this.#pool.assertAccepting()
    const plan = createPreparedToolPlan({ definition, provider: this.descriptor, input, limits,
      target: { kind: 'logical', resourceId: this.descriptor.resourceId } })
    this.#runtime!.onPrepare?.(plan)
    return this.#pool.prepare(plan, (committed, signal) => this.#runtime!.acquire(committed, signal))
  }
  dispose(): Promise<void> { return this.#pool.dispose(() => { this.#runtime = undefined }) }
}

/** Convenient one-shot scripted execution, with observable start and cleanup callbacks. */
export function createScriptedToolExecution(
  start: () => Awaitable<ToolExecutionResult>, close: () => Awaitable<void>,
): ToolExecution {
  let runtime: { readonly start: typeof start; readonly close: typeof close } | undefined = { start, close }
  let startTask: Promise<ToolExecutionResult> | undefined
  let closeTask: Promise<void> | undefined
  return Object.freeze({
    start: () => {
      if (startTask !== undefined || closeTask !== undefined) throw new TypeError('scripted execution is single-use')
      startTask = Promise.resolve().then(() => runtime!.start())
      void startTask.catch(() => undefined)
      return startTask
    },
    close: () => {
      closeTask ??= Promise.resolve().then(async () => {
        if (startTask !== undefined) await startTask.catch(() => undefined)
        await runtime!.close()
      }).finally(() => { runtime = undefined; startTask = undefined })
      void closeTask.catch(() => undefined)
      return closeTask
    },
  })
}

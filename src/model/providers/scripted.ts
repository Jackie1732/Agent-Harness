import type { Awaitable } from '../../effect/types.js'
import { snapshotJson } from '../../foundation/json.js'
import type { ModelFrame, ModelProvider, ModelProviderDescriptor, ModelRequest, ModelStreamLimits, PreparedModelCall, PreparedSubmission } from '../contract.js'
import { jsonBytes } from '../budget.js'
import { ModelError } from '../errors.js'
import { assertSameSubmission, createPreparedSubmission, decodeProviderDescriptor } from '../submission.js'
import { inModelTask } from '../task-context.js'
import { ExchangeCapacity } from './capacity.js'
import { ManagedModelExchange } from './exchange.js'

/** Deterministic provider controls; callbacks are test/research code, not model tools. */
export interface ScriptedModelProviderOptions {
  readonly providerId: string
  readonly maxConcurrentExchanges: number
  readonly streamLimits: ModelStreamLimits
  readonly script: (submission: PreparedSubmission, signal: AbortSignal) => Awaitable<AsyncIterable<ModelFrame>>
  readonly onPrepare?: (request: ModelRequest) => void
  /** A failing acquisition must undo any of its own partial resource work. */
  readonly onAcquire?: (submission: PreparedSubmission, signal: AbortSignal) => Awaitable<void>
  readonly onClose?: (submission: PreparedSubmission) => Awaitable<void>
}

interface ScriptRuntime {
  readonly script: ScriptedModelProviderOptions['script']
  readonly onPrepare: ScriptedModelProviderOptions['onPrepare']
  readonly onAcquire: ScriptedModelProviderOptions['onAcquire']
  readonly onClose: ScriptedModelProviderOptions['onClose']
}

/** Derive the immutable binding recorded by a scripted Provider without creating runtime state. */
export function scriptedModelDescriptor(
  options: Pick<ScriptedModelProviderOptions, 'providerId' | 'maxConcurrentExchanges' | 'streamLimits'>,
): ModelProviderDescriptor {
  return decodeProviderDescriptor(snapshotJson({
    providerId: options.providerId, protocol: 'scripted', adapterVersion: '1',
    endpoint: `scripted:${options.providerId}`, semanticHeaders: {},
    support: { text: true, instructions: true, tools: true, controls: ['temperature', 'topP'], profiles: [], continuations: [] },
    streamLimits: options.streamLimits, maxConcurrentExchanges: options.maxConcurrentExchanges,
  }))
}

/** Scripted requests obey the durable call protocol; disposal retires callbacks after exchanges finish. */
export class ScriptedModelProvider implements ModelProvider {
  readonly descriptor: ModelProviderDescriptor
  readonly #capacity: ExchangeCapacity
  #runtime: ScriptRuntime | undefined

  constructor(options: ScriptedModelProviderOptions) {
    if (typeof options.script !== 'function') throw new ModelError('MODEL_REQUEST_INVALID', 'Scripted provider requires a script')
    this.descriptor = scriptedModelDescriptor(options)
    this.#capacity = new ExchangeCapacity(options.maxConcurrentExchanges)
    this.#runtime = { script: options.script, onPrepare: options.onPrepare, onAcquire: options.onAcquire, onClose: options.onClose }
    Object.freeze(this)
  }

  prepare(request: ModelRequest): PreparedModelCall {
    this.#capacity.assertActive()
    const submission = createPreparedSubmission(request, this.descriptor, request)
    this.#runtime!.onPrepare?.(submission.request)
    let acquired = false
    return Object.freeze({
      submission,
      acquire: async (committed: PreparedSubmission, signal: AbortSignal) => {
        if (acquired) throw new ModelError('MODEL_STATE_INVALID', 'prepared binding cannot acquire a second exchange')
        assertSameSubmission(submission, committed)
        const ticket = this.#capacity.reserve()
        const runtime = this.#runtime!
        const capacity = this.#capacity
        const limits = this.descriptor.streamLimits
        acquired = true
        try {
          await inModelTask(ticket.token, () => runtime.onAcquire?.(committed, signal))
          return new ManagedModelExchange({
            assertActive: () => capacity.assertActive(),
            open: async currentSignal => boundedScript(await runtime.script(committed, currentSignal), limits),
            release: async () => { await runtime.onClose?.(committed) },
          }, signal, ticket)
        } catch (reason) {
          ticket.settle()
          throw reason
        }
      },
    })
  }

  dispose(): Promise<void> { return this.#capacity.dispose(() => { this.#runtime = undefined }) }
}

async function* boundedScript(source: AsyncIterable<ModelFrame>, limits: ModelStreamLimits): AsyncGenerator<ModelFrame> {
  let frames = 0
  let bytes = 0
  for await (const frame of source) {
    let copy: ModelFrame
    try { copy = snapshotJson(frame) as unknown as ModelFrame }
    catch { throw new ModelError('MODEL_PROTOCOL_INVALID', 'scripted frame is not finite plain JSON') }
    frames += 1
    const size = jsonBytes(copy)
    bytes += size
    if (frames > limits.maxFrames || bytes > limits.maxStreamBytes || size > limits.maxFrameBytes) {
      throw new ModelError('MODEL_LIMIT_EXCEEDED', 'scripted stream exceeds its explicit receive budget')
    }
    yield copy
  }
}

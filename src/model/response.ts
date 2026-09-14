import { snapshotJson } from '../foundation/json.js'
import type { JsonObject } from '../foundation/json.js'
import type {
  ModelFrame, ModelOutputBlock, ModelProviderDescriptor, ModelRequest,
  ModelRunnerLimits, ModelStopReason, NormalizedModelResult,
} from './contract.js'
import { emptyModelResult, jsonBytes } from './budget.js'
import { ModelError } from './errors.js'
import { decodeContinuation } from './request.js'
import { argumentStatus, decodeUsageCounts, stopReasons, usageFields, usageWithCompleteness } from './result-codec.js'
import { integer, keys, object, oneOf, text } from './validation.js'

/** Owns only one bounded normalized result and stream/block validation state. */
export class ModelResponseAccumulator {
  readonly #limits: ModelRunnerLimits
  readonly #binding: ModelProviderDescriptor
  readonly #request: ModelRequest
  readonly #advertised: ReadonlySet<string>
  #result: NormalizedModelResult = emptyModelResult()
  #messageStarted = false
  #frameCount = 0

  constructor(request: ModelRequest, binding: ModelProviderDescriptor, limits: ModelRunnerLimits) {
    this.#request = request
    this.#binding = binding
    this.#limits = limits
    this.#advertised = new Set(request.tools.map(tool => tool.name))
  }

  get protocolComplete(): boolean { return this.#result.protocolComplete }
  get responseObserved(): boolean { return this.#messageStarted }
  get stopReason(): ModelStopReason | null { return this.#result.stopReason }

  /** Caller mutation and provider accessors cannot alter accepted frame content. */
  accept(frame: ModelFrame): void {
    this.#frameCount += 1
    if (this.#frameCount > this.#binding.streamLimits.maxFrames) this.#limit('normalized frame count')
    try {
      const value = object(snapshotJson(frame), 'model frame')
      if (jsonBytes(value) > this.#binding.streamLimits.maxFrameBytes) this.#limit('normalized frame bytes')
      if (this.#result.protocolComplete) this.#invalid('frame follows protocol completion')
      this.#apply(value)
    } catch (reason) {
      if (reason instanceof ModelError && (reason.code === 'MODEL_LIMIT_EXCEEDED' || reason.code === 'MODEL_PROTOCOL_INVALID')) throw reason
      this.#invalid('normalized model frame failed validation')
    }
  }

  /** A complete marker is mandatory; EOF alone is not a successful model response. */
  requireComplete(): void {
    if (!this.#result.protocolComplete) this.#invalid('model stream ended without protocol completion')
  }

  snapshot(): NormalizedModelResult {
    return snapshotJson(this.#result) as NormalizedModelResult
  }

  #apply(frame: JsonObject): void {
    if (frame.kind === 'message-start') {
      keys(frame, ['kind', 'reportedModel', 'responseId'], ['requestId'])
      if (this.#messageStarted) this.#invalid('message started more than once')
      const reportedModel = text(frame.reportedModel, 'reported model', 256, false)
      const responseId = text(frame.responseId, 'response identity', 256, false)
      const requestId = frame.requestId === undefined ? undefined : text(frame.requestId, 'request identity', 256, false)
      this.#admit({ ...this.#result, reportedModel, responseId, ...(requestId === undefined ? {} : { requestId }) })
      this.#messageStarted = true
      return
    }
    if (!this.#messageStarted) this.#invalid('model content precedes message start')
    switch (frame.kind) {
      case 'block-start': this.#startBlock(frame); return
      case 'text-delta':
      case 'arguments-delta':
      case 'continuation-delta': this.#delta(frame); return
      case 'block-end': this.#endBlock(frame); return
      case 'usage': this.#usage(frame); return
      case 'generation-stop':
      case 'complete': this.#finish(frame); return
      default: this.#invalid('unknown normalized frame kind')
    }
  }

  #startBlock(frame: JsonObject): void {
    if (this.#result.stopReason !== null) this.#invalid('content starts after generation stopped')
    const index = integer(frame.index, 'output block index')
    if (index !== this.#result.blocks.length) this.#invalid('output block indexes must be contiguous and unique')
    if (index >= this.#limits.maxOutputBlocks) this.#limit('output block count')
    let block: ModelOutputBlock
    if (frame.block === 'text') {
      keys(frame, ['kind', 'index', 'block'])
      block = { kind: 'text', index, text: '', complete: false }
    } else if (frame.block === 'tool-call') {
      keys(frame, ['kind', 'index', 'block', 'callId', 'name'])
      const callId = text(frame.callId, 'tool call identity', 256, false)
      const name = text(frame.name, 'tool name', 64, false)
      const tools = this.#result.blocks.filter(item => item.kind === 'tool-call')
      if (tools.length >= this.#limits.maxToolCalls) this.#limit('tool intent count')
      if (tools.some(item => item.kind === 'tool-call' && item.callId === callId)) this.#invalid('response tool identity repeated')
      block = { kind: 'tool-call', index, callId, name, argumentsText: '', argumentsStatus: 'partial', advertisement: this.#advertised.has(name) ? 'advertised' : 'not-advertised', complete: false }
    } else if (frame.block === 'continuation') {
      keys(frame, ['kind', 'index', 'block', 'namespace', 'version', 'providerId', 'model'])
      const capsule = decodeContinuation({ namespace: frame.namespace ?? null, version: frame.version ?? null, providerId: frame.providerId ?? null, model: frame.model ?? null, text: '' })
      if (!this.#binding.support.continuations.includes(`${capsule.namespace}@${capsule.version}`)
        || capsule.providerId !== this.#binding.providerId || capsule.model !== this.#request.model) {
        this.#invalid('response continuation belongs to an incompatible binding')
      }
      block = { kind: 'continuation', index, capsule, complete: false }
    } else this.#invalid('unsupported output block')
    this.#admit({ ...this.#result, blocks: [...this.#result.blocks, block] })
  }

  #delta(frame: JsonObject): void {
    keys(frame, ['kind', 'index', 'text'])
    if (this.#result.stopReason !== null) this.#invalid('content follows generation stop')
    const index = integer(frame.index, 'output block index')
    const block = this.#openBlock(index)
    const delta = text(frame.text, 'output delta')
    let next: ModelOutputBlock
    if (frame.kind === 'text-delta' && block.kind === 'text') next = { ...block, text: block.text + delta }
    else if (frame.kind === 'arguments-delta' && block.kind === 'tool-call') next = { ...block, argumentsText: block.argumentsText + delta }
    else if (frame.kind === 'continuation-delta' && block.kind === 'continuation') next = { ...block, capsule: { ...block.capsule, text: block.capsule.text + delta } }
    else this.#invalid('delta kind does not match its open block')
    this.#replace(index, next)
  }

  #endBlock(frame: JsonObject): void {
    keys(frame, ['kind', 'index'])
    const index = integer(frame.index, 'output block index')
    const block = this.#openBlock(index)
    const next: ModelOutputBlock = block.kind === 'tool-call'
      ? { ...block, complete: true, argumentsStatus: argumentStatus(block.argumentsText) }
      : { ...block, complete: true }
    this.#replace(index, next)
  }

  #usage(frame: JsonObject): void {
    keys(frame, ['kind', 'counts'])
    const update = decodeUsageCounts(object(frame.counts, 'usage counts'))
    const counts: Record<string, number> = {}
    for (const field of usageFields) {
      const before = this.#result.usage[field]
      const after = update[field] ?? before
      if (before !== undefined && after !== undefined && after < before) this.#invalid('cumulative usage decreased')
      if (after !== undefined) counts[field] = after
    }
    this.#admit({ ...this.#result, usage: usageWithCompleteness(counts, false) })
  }

  #finish(frame: JsonObject): void {
    keys(frame, ['kind', 'stopReason'])
    const reason = oneOf(frame.stopReason, stopReasons, 'stop reason')
    if (this.#result.blocks.some(block => !block.complete)) this.#invalid('generation ended with an open block')
    if (this.#result.stopReason !== null && (frame.kind === 'generation-stop' || this.#result.stopReason !== reason)) this.#invalid('generation stop is repeated or contradictory')
    if (reason === 'tool-calls' && !this.#result.blocks.some(block => block.kind === 'tool-call')) this.#invalid('tool stop has no tool intent')
    const protocolComplete = frame.kind === 'complete'
    const counts: Record<string, number> = {}
    for (const field of usageFields) {
      const value = this.#result.usage[field]
      if (value !== undefined) counts[field] = value
    }
    this.#admit({ ...this.#result, stopReason: reason, protocolComplete, usage: usageWithCompleteness(counts, protocolComplete) })
  }

  #openBlock(index: number): ModelOutputBlock {
    const block = this.#result.blocks[index]
    if (block === undefined || block.complete) this.#invalid('operation does not address an open output block')
    return block
  }

  #replace(index: number, next: ModelOutputBlock): void {
    const blocks = [...this.#result.blocks]
    blocks[index] = next
    this.#admit({ ...this.#result, blocks })
  }

  #admit(candidate: NormalizedModelResult): void {
    if (jsonBytes(candidate) > this.#limits.maxNormalizedResultBytes) this.#limit('normalized result bytes')
    this.#result = candidate
  }

  #invalid(message: string): never { throw new ModelError('MODEL_PROTOCOL_INVALID', message) }
  #limit(resource: string): never { throw new ModelError('MODEL_LIMIT_EXCEEDED', `${resource} exceeded its explicit limit`) }
}

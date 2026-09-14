import { isJsonValue } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { ModelStopReason, ModelUsage, ModelUsageCounts, NormalizedModelResult } from './contract.js'
import { ModelError } from './errors.js'
import { decodeContinuation } from './request.js'
import { bool, integer, keys, list, object, oneOf, text } from './validation.js'

export const stopReasons: readonly ModelStopReason[] = ['stop', 'tool-calls', 'length', 'refusal', 'content-filter']
export const usageFields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'reasoningOutputTokens'] as const

export function argumentStatus(value: string): 'valid-json' | 'invalid-json' {
  try { return isJsonValue(JSON.parse(value)) ? 'valid-json' : 'invalid-json' }
  catch { return 'invalid-json' }
}

/** Counters are provider cumulative totals; the accumulator never sums repeated totals. */
export function decodeUsageCounts(value: JsonObject): ModelUsageCounts {
  keys(value, [], usageFields)
  for (const field of usageFields) if (value[field] !== undefined) integer(value[field], 'usage counter')
  return value as ModelUsageCounts
}

export function usageWithCompleteness(counts: ModelUsageCounts, protocolComplete: boolean): ModelUsage {
  const any = usageFields.some(field => counts[field] !== undefined)
  const complete = protocolComplete && counts.inputTokens !== undefined && counts.outputTokens !== undefined
  return { ...counts, source: 'provider', completeness: complete ? 'complete' : any ? 'partial' : 'unknown' }
}

/** Validate the compact durable result; malformed histories fail closed on replay. */
export function decodeNormalizedResult(value: JsonValue): NormalizedModelResult {
  const result = object(value, 'normalized result')
  keys(result, ['blocks', 'usage', 'protocolComplete', 'stopReason'], ['reportedModel', 'responseId', 'requestId'])
  const complete = bool(result.protocolComplete, 'protocol completion')
  if (result.stopReason !== null) oneOf(result.stopReason, stopReasons, 'stop reason')
  if (complete && result.stopReason === null) throw new ModelError('MODEL_STATE_INVALID', 'complete result lacks a stop reason')
  for (const field of ['reportedModel', 'responseId', 'requestId'] as const) {
    if (result[field] !== undefined) text(result[field], 'remote evidence', 256, false)
  }
  if ((result.reportedModel === undefined) !== (result.responseId === undefined)) {
    throw new ModelError('MODEL_STATE_INVALID', 'response identity and reported model must be recorded together')
  }
  const blocks = list(result.blocks, 'output blocks')
  const ids = new Set<string>()
  for (let index = 0; index < blocks.length; index += 1) {
    const block = object(blocks[index], 'output block')
    if (integer(block.index, 'output block index') !== index) throw new ModelError('MODEL_STATE_INVALID', 'durable output indexes are not contiguous')
    const closed = bool(block.complete, 'block completion')
    if ((complete || result.stopReason !== null) && !closed) throw new ModelError('MODEL_STATE_INVALID', 'stopped output contains open blocks')
    if (block.kind === 'text') {
      keys(block, ['kind', 'index', 'text', 'complete'])
      text(block.text, 'output text')
    } else if (block.kind === 'tool-call') {
      keys(block, ['kind', 'index', 'callId', 'name', 'argumentsText', 'argumentsStatus', 'advertisement', 'complete'])
      const id = text(block.callId, 'tool call identity', 256, false)
      if (ids.has(id)) throw new ModelError('MODEL_STATE_INVALID', 'durable tool identities repeat')
      ids.add(id)
      text(block.name, 'tool name', 64, false)
      const argumentsText = text(block.argumentsText, 'tool arguments')
      if (block.argumentsStatus !== (closed ? argumentStatus(argumentsText) : 'partial')) {
        throw new ModelError('MODEL_STATE_INVALID', 'durable tool parse status differs from its raw arguments')
      }
      oneOf(block.advertisement, ['advertised', 'not-advertised'], 'tool advertisement')
    } else if (block.kind === 'continuation') {
      keys(block, ['kind', 'index', 'capsule', 'complete'])
      decodeContinuation(block.capsule)
    } else throw new ModelError('MODEL_STATE_INVALID', 'durable output kind is unsupported')
  }
  if (result.stopReason === 'tool-calls' && ids.size === 0) throw new ModelError('MODEL_STATE_INVALID', 'tool stop has no durable tool intent')
  const usage = object(result.usage, 'usage')
  keys(usage, ['source', 'completeness'], usageFields)
  if (usage.source !== 'provider') throw new ModelError('MODEL_STATE_INVALID', 'usage source is unsupported')
  const counts: Record<string, number> = {}
  for (const field of usageFields) if (usage[field] !== undefined) counts[field] = integer(usage[field], 'usage counter')
  if (usage.completeness !== usageWithCompleteness(counts, complete).completeness) {
    throw new ModelError('MODEL_STATE_INVALID', 'usage completeness does not match the recorded observations')
  }
  if ((blocks.length > 0 || complete || Object.keys(counts).length > 0) && result.responseId === undefined) {
    throw new ModelError('MODEL_STATE_INVALID', 'model output has no response observation')
  }
  return result as NormalizedModelResult
}

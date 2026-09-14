import type { ModelFrame, ModelStopReason, ModelUsageCounts, PreparedSubmission } from '../../contract.js'
import { ModelError } from '../../errors.js'
import type { SseRecord } from '../http/sse.js'
import { usageFields, wireArray, wireId, wireIndex, wireInvalid, wireJson, wireKeys, wireObject, wireText } from '../http/wire.js'

/** Messages decoder: content indexes, cumulative usage and message_stop stay distinct. */
export async function* decodeAnthropicStream(
  records: AsyncIterable<SseRecord>, _submission: PreparedSubmission, requestId?: string,
): AsyncGenerator<ModelFrame> {
  let started = false
  let terminal = false
  let stop: ModelStopReason | undefined
  let usage: ModelUsageCounts = {}
  const blocks: { kind: 'text' | 'tool-call'; closed: boolean; argumentsSeen: boolean }[] = []
  for await (const record of records) {
    if (record.data === '' && record.event === '') continue
    const event = wireJson(record.data)
    if (event.type !== record.event) throw wireInvalid()
    if (event.type === 'ping') { wireKeys(event, ['type']); continue }
    if (terminal) throw wireInvalid()
    if (event.type === 'error') {
      const error = wireObject(event.error)
      const known = ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'api_error', 'overloaded_error']
      if (typeof error.type !== 'string' || !known.includes(error.type)) throw wireInvalid()
      const statuses: Record<string, number> = { invalid_request_error: 400, authentication_error: 401, permission_error: 403, not_found_error: 404, rate_limit_error: 429, api_error: 500, overloaded_error: 529 }
      const status = statuses[error.type]
      if (status === undefined) throw wireInvalid()
      throw new ModelError('MODEL_HTTP_FAILED', 'model service returned a stream error', { httpStatus: status })
    }
    if (event.type === 'message_start') {
      if (started) throw wireInvalid()
      wireKeys(event, ['type', 'message'])
      const message = wireObject(event.message)
      wireKeys(message, ['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence'], ['usage'])
      if (message.type !== 'message' || message.role !== 'assistant' || wireArray(message.content).length !== 0
        || message.stop_reason !== null || message.stop_sequence !== null) throw wireInvalid()
      started = true
      yield { kind: 'message-start', reportedModel: wireId(message.model), responseId: wireId(message.id), ...(requestId === undefined ? {} : { requestId }) }
      if (message.usage !== undefined) { usage = anthropicUsage(message.usage); yield { kind: 'usage', counts: usage } }
      continue
    }
    if (!started) throw wireInvalid()
    switch (event.type) {
      case 'content_block_start': {
        wireKeys(event, ['type', 'index', 'content_block'])
        const index = wireIndex(event.index)
        if (index !== blocks.length || stop !== undefined) throw wireInvalid()
        const block = wireObject(event.content_block)
        if (block.type === 'text') {
          wireKeys(block, ['type', 'text'])
          blocks.push({ kind: 'text', closed: false, argumentsSeen: false })
          yield { kind: 'block-start', index, block: 'text' }
          yield { kind: 'text-delta', index, text: wireText(block.text) }
        } else if (block.type === 'tool_use') {
          wireKeys(block, ['type', 'id', 'name', 'input'])
          if (Object.keys(wireObject(block.input)).length !== 0) throw wireInvalid()
          blocks.push({ kind: 'tool-call', closed: false, argumentsSeen: false })
          yield { kind: 'block-start', index, block: 'tool-call', callId: wireId(block.id), name: wireId(block.name) }
        } else throw wireInvalid() // signed thinking, fallback and server tools are not this profile.
        break
      }
      case 'content_block_delta': {
        wireKeys(event, ['type', 'index', 'delta'])
        const index = wireIndex(event.index)
        const block = blocks[index]
        if (block === undefined || block.closed || stop !== undefined) throw wireInvalid()
        const delta = wireObject(event.delta)
        if (delta.type === 'text_delta' && block.kind === 'text') {
          wireKeys(delta, ['type', 'text']); yield { kind: 'text-delta', index, text: wireText(delta.text) }
        } else if (delta.type === 'input_json_delta' && block.kind === 'tool-call') {
          wireKeys(delta, ['type', 'partial_json'])
          const text = wireText(delta.partial_json)
          if (text.length > 0) block.argumentsSeen = true
          yield { kind: 'arguments-delta', index, text }
        } else throw wireInvalid()
        break
      }
      case 'content_block_stop': {
        wireKeys(event, ['type', 'index'])
        const index = wireIndex(event.index)
        const block = blocks[index]
        if (block === undefined || block.closed || stop !== undefined) throw wireInvalid()
        if (block.kind === 'tool-call' && !block.argumentsSeen) yield { kind: 'arguments-delta', index, text: '{}' }
        block.closed = true
        yield { kind: 'block-end', index }
        break
      }
      case 'message_delta': {
        wireKeys(event, ['type', 'delta'], ['usage'])
        if (blocks.some(block => !block.closed)) throw wireInvalid()
        const delta = wireObject(event.delta)
        wireKeys(delta, ['stop_reason'], ['stop_sequence'])
        if (delta.stop_sequence != null) throw wireInvalid()
        if (delta.stop_reason !== null) {
          const next = messagesStop(delta.stop_reason)
          if (stop !== undefined && stop !== next) throw wireInvalid()
          if (stop === undefined) { stop = next; yield { kind: 'generation-stop', stopReason: stop } }
        }
        if (event.usage !== undefined) { usage = { ...usage, ...anthropicUsage(event.usage) }; yield { kind: 'usage', counts: usage } }
        break
      }
      case 'message_stop':
        wireKeys(event, ['type'])
        if (stop === undefined || blocks.some(block => !block.closed)) throw wireInvalid()
        terminal = true
        yield { kind: 'complete', stopReason: stop }
        break
      default: throw wireInvalid()
    }
  }
  if (!terminal || stop === undefined) throw wireInvalid()
}
function messagesStop(reason: unknown): ModelStopReason {
  switch (reason) {
    case 'end_turn': return 'stop'
    case 'tool_use': return 'tool-calls'
    case 'max_tokens': return 'length'
    case 'refusal': return 'refusal'
    default: throw wireInvalid()
  }
}
function anthropicUsage(value: unknown): ModelUsageCounts {
  return usageFields(value, { input_tokens: 'inputTokens', output_tokens: 'outputTokens',
    cache_read_input_tokens: 'cacheReadInputTokens', cache_creation_input_tokens: 'cacheCreationInputTokens' })
}

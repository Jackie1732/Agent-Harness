import type { JsonObject } from '../../../foundation/json.js'
import type { ModelFrame, ModelStopReason, PreparedSubmission } from '../../contract.js'
import type { SseRecord } from '../http/sse.js'
import { usageFields, wireArray, wireId, wireIndex, wireInvalid, wireJson, wireKeys, wireObject, wireText } from '../http/wire.js'
import { DEEPSEEK_CONTINUATION } from './encode.js'

/** Stateful Chat decoder. Tool indexes and output-block indexes are separate spaces. */
export async function* decodeDeepSeekStream(
  records: AsyncIterable<SseRecord>, submission: PreparedSubmission, requestId?: string,
): AsyncGenerator<ModelFrame> {
  let identity: { id: string; model: string } | undefined
  let blockCount = 0
  let textIndex: number | undefined
  let reasoningIndex: number | undefined
  const tools = new Map<number, { index: number; id: string; name: string }>()
  let stop: ModelStopReason | undefined
  let terminal = false
  for await (const record of records) {
    if (record.data === '' && record.event === '') continue
    if (record.event !== '' && record.event !== 'message') throw wireInvalid()
    if (terminal) throw wireInvalid()
    if (record.data === '[DONE]') {
      if (identity === undefined || stop === undefined) throw wireInvalid()
      terminal = true
      yield { kind: 'complete', stopReason: stop }
      continue // still verify the transport tail before durable settlement
    }
    const chunk = wireJson(record.data)
    wireKeys(chunk, ['id', 'object', 'created', 'model', 'choices'], ['usage', 'system_fingerprint'])
    if (chunk.object !== 'chat.completion.chunk') throw wireInvalid()
    wireIndex(chunk.created)
    const id = wireId(chunk.id)
    const model = wireId(chunk.model)
    if (identity === undefined) {
      identity = { id, model }
      yield { kind: 'message-start', reportedModel: model, responseId: id, ...(requestId === undefined ? {} : { requestId }) }
    } else if (identity.id !== id || identity.model !== model) throw wireInvalid()
    const choices = wireArray(chunk.choices)
    // Current DeepSeek contract returns one choice, including its final usage chunk.
    if (choices.length !== 1) throw wireInvalid()
    const choice = wireObject(choices[0])
    wireKeys(choice, ['index', 'delta', 'finish_reason'], ['logprobs'])
    if (choice.index !== 0 || choice.logprobs != null) throw wireInvalid()
    const delta = wireObject(choice.delta)
    wireKeys(delta, [], ['role', 'content', 'reasoning_content', 'tool_calls'])
    if (delta.role !== undefined && delta.role !== 'assistant') throw wireInvalid()
    if (stop !== undefined && Object.keys(delta).some(key => delta[key] != null && delta[key] !== '')) throw wireInvalid()
    if (delta.reasoning_content != null) {
      const thinking = wireObject(submission.wireBody.thinking)
      if (thinking.type !== 'enabled') throw wireInvalid()
      const text = wireText(delta.reasoning_content)
      if (reasoningIndex === undefined) {
        reasoningIndex = blockCount++
        yield { kind: 'block-start', index: reasoningIndex, block: 'continuation', namespace: DEEPSEEK_CONTINUATION,
          version: 1, providerId: submission.binding.providerId, model: submission.request.model }
      }
      yield { kind: 'continuation-delta', index: reasoningIndex, text }
    }
    if (delta.content != null) {
      const text = wireText(delta.content)
      if (textIndex === undefined) { textIndex = blockCount++; yield { kind: 'block-start', index: textIndex, block: 'text' } }
      yield { kind: 'text-delta', index: textIndex, text }
    }
    if (delta.tool_calls != null) {
      for (const input of wireArray(delta.tool_calls)) {
        const call = wireObject(input)
        wireKeys(call, ['index', 'function'], ['id', 'type'])
        const key = wireIndex(call.index)
        const fn = wireObject(call.function)
        wireKeys(fn, [], ['name', 'arguments'])
        let tool = tools.get(key)
        if (tool === undefined) {
          if (key !== tools.size || call.type !== 'function') throw wireInvalid()
          tool = { index: blockCount++, id: wireId(call.id), name: wireId(fn.name) }
          if ([...tools.values()].some(other => other.id === tool?.id)) throw wireInvalid()
          tools.set(key, tool)
          yield { kind: 'block-start', index: tool.index, block: 'tool-call', callId: tool.id, name: tool.name }
        } else if (call.id !== undefined && call.id !== tool.id || call.type !== undefined && call.type !== 'function'
          || fn.name !== undefined && fn.name !== tool.name) throw wireInvalid()
        if (fn.arguments !== undefined) yield { kind: 'arguments-delta', index: tool.index, text: wireText(fn.arguments) }
      }
    }
    if (choice.finish_reason !== null) {
      if (stop !== undefined) throw wireInvalid()
      stop = chatStop(choice.finish_reason)
      for (let index = 0; index < blockCount; index += 1) yield { kind: 'block-end', index }
      yield { kind: 'generation-stop', stopReason: stop }
    }
    if (chunk.usage != null) yield { kind: 'usage', counts: chatUsage(wireObject(chunk.usage)) }
  }
  if (!terminal || stop === undefined) throw wireInvalid()
}

function chatStop(reason: unknown): ModelStopReason {
  switch (reason) {
    case 'stop': return 'stop'
    case 'tool_calls': return 'tool-calls'
    case 'length': return 'length'
    case 'content_filter': return 'content-filter'
    default: throw wireInvalid()
  }
}
function chatUsage(usage: JsonObject) {
  const base = usageFields(usage, { prompt_tokens: 'inputTokens', completion_tokens: 'outputTokens', prompt_cache_hit_tokens: 'cacheReadInputTokens' })
  if (usage.total_tokens !== undefined) wireIndex(usage.total_tokens)
  if (usage.prompt_cache_miss_tokens !== undefined) wireIndex(usage.prompt_cache_miss_tokens)
  const details = usage.completion_tokens_details == null ? undefined : wireObject(usage.completion_tokens_details)
  return { ...base, ...(details?.reasoning_tokens === undefined ? {} : { reasoningOutputTokens: wireIndex(details.reasoning_tokens) }) }
}

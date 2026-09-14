import { canonicalJsonBytes } from '../../../foundation/canonical-json.js'
import type { JsonObject } from '../../../foundation/json.js'
import type { ModelProviderDescriptor, ModelRequest } from '../../contract.js'
import { ModelError } from '../../errors.js'
import { snapshotModelRequest } from '../../request.js'

export const DEEPSEEK_PROFILE = 'deepseek.chat'
export const DEEPSEEK_CONTINUATION = 'deepseek.reasoning'

/** Compile exactly the supported Chat profile; service defaults are never guessed. */
export function encodeDeepSeekRequest(input: ModelRequest, binding: ModelProviderDescriptor): JsonObject {
  const request = snapshotModelRequest(input)
  let thinking: 'enabled' | 'disabled' = 'disabled'
  if (request.profile !== undefined) {
    const profile = request.profile
    if (profile.namespace !== DEEPSEEK_PROFILE || profile.version !== 1
      || Object.keys(profile.options).length !== 1
      || profile.options.thinking !== 'enabled' && profile.options.thinking !== 'disabled') throw unsupported()
    thinking = profile.options.thinking
  }
  // The public docs disagree on some top_p combinations. Reject rather than claim a
  // silently clamped/ignored value was honored. A new supported profile needs fixtures.
  if (request.topP !== undefined) throw unsupported()
  if (request.temperature !== undefined && (thinking === 'enabled' || request.temperature < 0 || request.temperature > 2)) throw unsupported()
  if (request.maxOutputTokens > 393216) throw unsupported()
  const messages: JsonObject[] = request.instructions.map(content => ({ role: 'system', content }))
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const calls: JsonObject[] = []
      let content = ''
      for (const block of message.content) {
        if (block.kind === 'text') {
          if (calls.length > 0) throw unsupported() // Chat cannot represent text after an action block.
          content += block.text
        } else calls.push({ id: block.callId, type: 'function', function: { name: block.name, arguments: block.argumentsText } })
      }
      const capsule = message.continuation
      if (capsule !== undefined && (capsule.namespace !== DEEPSEEK_CONTINUATION || capsule.version !== 1
        || capsule.providerId !== binding.providerId || capsule.model !== request.model || thinking !== 'enabled' || calls.length === 0)) throw unsupported()
      if (thinking === 'enabled' && calls.length > 0 && capsule === undefined) throw unsupported()
      messages.push({ role: 'assistant', content, ...(calls.length === 0 ? {} : { tool_calls: calls }),
        ...(capsule === undefined ? {} : { reasoning_content: capsule.text }) })
    } else {
      let content = ''
      let hasText = false
      for (const block of message.content) {
        if (block.kind === 'text') { content += block.text; hasText = true }
        else {
          if (hasText) throw unsupported()
          // Chat has no is_error field: this explicit deterministic JSON envelope
          // preserves both the caller's value and error marker in the wire snapshot.
          const result = Buffer.from(canonicalJsonBytes({ result: block.result, isError: block.isError })).toString('utf8')
          messages.push({ role: 'tool', tool_call_id: block.callId, content: result })
        }
      }
      if (hasText) messages.push({ role: 'user', content })
    }
  }
  return {
    model: request.model, messages, stream: true, max_tokens: request.maxOutputTokens,
    thinking: { type: thinking },
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.tools.length === 0 ? {} : { tools: request.tools.map(tool => ({ type: 'function', function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })) }),
  }
}
function unsupported(): ModelError { return new ModelError('MODEL_FEATURE_UNSUPPORTED', 'request cannot be losslessly expressed by the supported DeepSeek Chat profile') }

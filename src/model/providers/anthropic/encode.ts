import { canonicalJsonBytes } from '../../../foundation/canonical-json.js'
import { assertJsonValue } from '../../../foundation/json.js'
import type { JsonObject } from '../../../foundation/json.js'
import type { ModelRequest } from '../../contract.js'
import { ModelError } from '../../errors.js'
import { snapshotModelRequest } from '../../request.js'

/** Messages has native text/tool blocks and error-marked tool results. */
export function encodeAnthropicRequest(input: ModelRequest): JsonObject {
  const request = snapshotModelRequest(input)
  if (request.profile !== undefined || request.messages.some(message => message.role === 'assistant' && message.continuation !== undefined)) throw unsupported()
  if (request.temperature !== undefined && (request.temperature < 0 || request.temperature > 1)
    || request.topP !== undefined && (request.topP < 0 || request.topP > 1)) throw unsupported()
  const messages = request.messages.map(message => ({
    role: message.role,
    content: message.content.map(block => {
      switch (block.kind) {
        case 'text': return { type: 'text', text: block.text }
        case 'tool-call': {
          let value: unknown
          try { value = JSON.parse(block.argumentsText); assertJsonValue(value) }
          catch { throw unsupported() }
          if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unsupported()
          return { type: 'tool_use', id: block.callId, name: block.name, input: value as JsonObject }
        }
        case 'tool-result': return { type: 'tool_result', tool_use_id: block.callId, is_error: block.isError,
          content: typeof block.result === 'string' ? block.result : Buffer.from(canonicalJsonBytes(block.result)).toString('utf8') }
      }
    }),
  }))
  return {
    model: request.model, messages, max_tokens: request.maxOutputTokens, stream: true,
    ...(request.instructions.length === 0 ? {} : { system: request.instructions.map(text => ({ type: 'text', text })) }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.tools.length === 0 ? {} : { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }),
  }
}
function unsupported(): ModelError { return new ModelError('MODEL_FEATURE_UNSUPPORTED', 'request cannot be losslessly expressed by the supported Anthropic Messages profile') }

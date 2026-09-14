import type { ModelProvider } from '../contract.js'
import { HttpModelProvider } from './http/provider.js'
import type { HttpModelProviderOptions } from './http/provider.js'
import { encodeAnthropicRequest } from './anthropic/encode.js'
import { decodeAnthropicStream } from './anthropic/stream.js'

/** Text and client function tools only; unsupported thinking/server tool blocks fail closed. */
export function createAnthropicModelProvider(options: HttpModelProviderOptions): ModelProvider {
  return new HttpModelProvider(options, {
    name: 'anthropic.messages', version: '1',
    support: { text: true, instructions: true, tools: true, controls: ['temperature', 'topP'], profiles: [], continuations: [] },
    semanticHeaders: { 'anthropic-version': '2023-06-01' }, authentication: key => ({ 'x-api-key': key }),
    encode: encodeAnthropicRequest, decode: decodeAnthropicStream,
  })
}

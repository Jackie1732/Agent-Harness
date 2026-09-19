import type { ModelProvider } from '../contract.js'
import { HttpModelProvider, httpModelDescriptor } from './http/provider.js'
import type { HttpModelProviderOptions } from './http/provider.js'
import { encodeAnthropicRequest } from './anthropic/encode.js'
import { decodeAnthropicStream } from './anthropic/stream.js'

const anthropicProtocol = {
  name: 'anthropic.messages', version: '1',
  support: { text: true, instructions: true, tools: true, controls: ['temperature', 'topP'] as const, profiles: [], continuations: [] },
  semanticHeaders: { 'anthropic-version': '2023-06-01' }, authentication: (key: string) => ({ 'x-api-key': key }),
  encode: encodeAnthropicRequest, decode: decodeAnthropicStream,
}

export function anthropicModelDescriptor(options: Omit<HttpModelProviderOptions, 'apiKey'>) {
  return httpModelDescriptor(options, anthropicProtocol)
}

/** Text and client function tools only; unsupported thinking/server tool blocks fail closed. */
export function createAnthropicModelProvider(options: HttpModelProviderOptions): ModelProvider {
  return new HttpModelProvider(options, anthropicProtocol)
}

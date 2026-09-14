import type { ModelProvider } from '../contract.js'
import { HttpModelProvider } from './http/provider.js'
import type { HttpModelProviderOptions } from './http/provider.js'
import { DEEPSEEK_CONTINUATION, DEEPSEEK_PROFILE, encodeDeepSeekRequest } from './deepseek/encode.js'
import { decodeDeepSeekStream } from './deepseek/stream.js'

/** Supported text/function/thinking-continuation Chat adapter; no implicit retries. */
export function createDeepSeekModelProvider(options: HttpModelProviderOptions): ModelProvider {
  return new HttpModelProvider(options, {
    name: 'deepseek.chat', version: '1',
    support: { text: true, instructions: true, tools: true, controls: ['temperature'],
      profiles: [`${DEEPSEEK_PROFILE}@1`], continuations: [`${DEEPSEEK_CONTINUATION}@1`] },
    semanticHeaders: {}, authentication: key => ({ authorization: `Bearer ${key}` }),
    encode: encodeDeepSeekRequest, decode: decodeDeepSeekStream,
  })
}

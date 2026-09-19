import type { ModelFrame } from '../model/contract.js'
import { ScriptedModelProvider } from '../model/providers/scripted.js'
import { createDeepSeekModelProvider } from '../model/providers/deepseek.js'
import { createAnthropicModelProvider } from '../model/providers/anthropic.js'
import type { ModelProvider } from '../model/contract.js'
import type { HostModelConfig } from './config.js'
import { HostError } from './errors.js'

async function* fixedTextFrames(providerId: string, text: string): AsyncGenerator<ModelFrame> {
  yield { kind: 'message-start', reportedModel: providerId, responseId: `${providerId}-fixed-response` }
  yield { kind: 'block-start', index: 0, block: 'text' }
  yield { kind: 'text-delta', index: 0, text }
  yield { kind: 'block-end', index: 0 }
  yield { kind: 'usage', counts: { inputTokens: 0, outputTokens: 0 } }
  yield { kind: 'complete', stopReason: 'stop' }
}

/** Create one independent runtime Provider for a single Host slot. */
export function createHostModelProvider(config: HostModelConfig, credentials: Readonly<Record<string, string>>): ModelProvider {
  if (config.kind === 'scripted-fixed') {
    return new ScriptedModelProvider({ providerId: config.providerId, maxConcurrentExchanges: config.maxConcurrentExchanges,
      streamLimits: config.streamLimits, script: () => fixedTextFrames(config.providerId, config.text) })
  }
  const apiKey = credentials[config.credentialRef]
  if (apiKey === undefined) throw new HostError('HOST_CONFIG_INVALID', 'model-credential-missing', { credentialRef: config.credentialRef })
  const options = { providerId: config.providerId, endpoint: config.endpoint, apiKey,
    maxConcurrentExchanges: config.maxConcurrentExchanges, streamLimits: config.streamLimits }
  return config.kind === 'deepseek' ? createDeepSeekModelProvider(options) : createAnthropicModelProvider(options)
}

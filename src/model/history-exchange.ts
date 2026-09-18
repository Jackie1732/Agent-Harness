import type { ModelInputMessage, ModelToolResultBlock, NormalizedModelResult } from './contract.js'
import type { ModelInvocationId } from './ids.js'

/** Lossless assistant/result pairing shared by Tool and Agent history projections. */
export function composeModelExchange(
  invocationId: ModelInvocationId,
  result: NormalizedModelResult,
  results: readonly ModelToolResultBlock[],
  invalid: (reason: string) => never,
): { readonly assistant: Extract<ModelInputMessage, { role: 'assistant' }>; readonly results: Extract<ModelInputMessage, { role: 'user' }> } {
  const content: Extract<ModelInputMessage, { role: 'assistant' }>['content'][number][] = []
  let continuation: Extract<ModelInputMessage, { role: 'assistant' }>['continuation']
  let callIndex = 0
  for (const block of result.blocks) {
    if (!block.complete) invalid('incomplete-assistant-block')
    if (block.kind === 'text') content.push({ kind: 'text', text: block.text })
    else if (block.kind === 'continuation') {
      if (continuation !== undefined) invalid('multiple-continuations')
      continuation = block.capsule
    } else {
      const paired = results[callIndex++]
      if (paired === undefined || paired.callId !== block.callId || paired.source.invocationId !== invocationId
        || paired.source.outputBlockIndex !== block.index) invalid('unpaired-assistant-call')
      content.push({ kind: 'tool-call', callId: block.callId, name: block.name, argumentsText: block.argumentsText,
        source: { invocationId, outputBlockIndex: block.index } })
    }
  }
  if (callIndex === 0 || callIndex !== results.length) invalid('unexpected-result-count')
  return Object.freeze({ assistant: Object.freeze({ role: 'assistant', content: Object.freeze(content),
    ...(continuation === undefined ? {} : { continuation }) }), results: Object.freeze({ role: 'user', content: Object.freeze([...results]) }) })
}

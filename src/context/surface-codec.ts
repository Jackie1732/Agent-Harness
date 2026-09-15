import { createToolDefinition } from '../tool/definition.js'
import { describeToolForModel } from '../tool/model-bridge.js'
import { decodeToolProviderDescriptor } from '../tool/validation.js'
import type { ContextCapturedFacts, ContextToolSurface } from './contract.js'
import { invalidContext } from './errors.js'
import { array, boolean, contextJson, equalJson, exact, integer, record, text, unique } from './validation.js'

/** Full definitions and safe descriptors are observations, not live instance identities. */
export function decodeCapturedFacts(value: unknown): ContextCapturedFacts {
  const input = record(contextJson(value))
  exact(input, ['tools', 'messageSupport'])
  const tools = array(input.tools, 64).map(value => {
    const item = record(value); exact(item, ['definition', 'provider', 'model'])
    const surface = item as ContextToolSurface
    try {
      createToolDefinition(surface.definition, { maxSchemaBytes: 1024 * 1024, maxSchemaDepth: 64, maxSchemaNodes: 250000 })
      decodeToolProviderDescriptor(surface.provider)
      if (!equalJson(surface.model, describeToolForModel(surface.definition))) invalidContext('tool-model-surface')
      if (!surface.provider.tools.some(tool => tool.name === surface.definition.name && tool.version === surface.definition.version)) invalidContext('tool-provider-surface')
    } catch { invalidContext('tool-surface') }
    return surface
  })
  unique(tools.map(tool => tool.definition.name))
  const support = array(input.messageSupport).map(value => {
    const item = record(value); exact(item, ['type', 'payloadVersion', 'supported'])
    text(item.type, 128); integer(item.payloadVersion, 1); boolean(item.supported)
    return `${item.type as string}@${item.payloadVersion as number}`
  })
  unique(support)
  return input as ContextCapturedFacts
}

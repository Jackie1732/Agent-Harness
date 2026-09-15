import { decodeMessagePayload } from '../communication/message-catalog.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import { describeToolForModel } from '../tool/model-bridge.js'
import type { ToolRegistry } from '../tool/registry.js'
import type { ContextCapturedFacts, ContextProfile, ContextSelectionSpec } from './contract.js'
import { invalidSource } from './errors.js'
import type { ContextFacts } from './history.js'
import { messageKinds } from './history.js'
import { decodeCapturedFacts } from './surface-codec.js'

/** One synchronous surface observation. Capturing metadata never acquires tool execution rights. */
export function captureContextFacts(
  facts: ContextFacts,
  profile: ContextProfile,
  selection: ContextSelectionSpec,
  catalog: MessageCatalog,
  registry?: ToolRegistry,
): ContextCapturedFacts {
  const snapshot = profile.toolNames.length === 0 ? [] : registry?.snapshot() ?? []
  const tools = profile.toolNames.flatMap(name => {
    const item = snapshot.find(item => item.definition.name === name && item.status === 'active')
    return item === undefined ? [] : [{ definition: item.definition, provider: item.provider, model: describeToolForModel(item.definition) }]
  })
  const messageSupport = messageKinds(facts).map(kind => {
    const definition = catalog.resolve(kind.type, kind.payloadVersion)
    if (definition !== undefined) {
      if (definition.type !== kind.type || definition.payloadVersion !== kind.payloadVersion) invalidSource('message-catalog-resolution')
      for (const item of facts.local.communication.inbox) {
        if (item.status !== 'pending') continue
        if (item.envelope.type !== kind.type || item.envelope.payloadVersion !== kind.payloadVersion) continue
        if (selection.inbox.find(decision => decision.messageId === item.messageId)?.action !== 'include-full') continue
        try { decodeMessagePayload(definition, item.envelope.payload) } catch { invalidSource('message-payload-current-decoder') }
      }
    }
    return { ...kind, supported: definition !== undefined }
  })
  return decodeCapturedFacts({ tools, messageSupport })
}

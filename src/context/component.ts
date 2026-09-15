import { createCapabilityKey } from '../capability/key.js'
import type { CapabilityKey, ComponentContext, ComponentDefinition } from '../capability/types.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { ToolRegistry } from '../tool/registry.js'
import { SessionContext } from './session-context.js'

/** Default key for one Session-local Context coordinator in a capability graph. */
export const SessionContextKey = createCapabilityKey<SessionContext>('context.session')

/** Explicit borrowed dependencies for one SessionContext activation. */
export interface SessionContextComponentOptions {
  readonly label: string
  readonly sessionKey: CapabilityKey<SessionHandle>
  readonly messageCatalog: MessageCatalog
  readonly toolRegistryKey?: CapabilityKey<ToolRegistry>
  readonly key?: CapabilityKey<SessionContext>
}

/** Publish one Context coordinator and close it before borrowed capabilities are released. */
export function createSessionContextComponent(options: SessionContextComponentOptions): ComponentDefinition {
  const key = options.key ?? SessionContextKey
  const requires = options.toolRegistryKey === undefined
    ? [options.sessionKey]
    : [options.sessionKey, options.toolRegistryKey]
  return Object.freeze({
    label: options.label,
    requires: Object.freeze(requires),
    provides: Object.freeze([key]),
    setup: async (context: ComponentContext) => {
      const session = context.require(options.sessionKey)
      const toolRegistry = options.toolRegistryKey === undefined
        ? undefined
        : context.require(options.toolRegistryKey)
      const value = await context.apply(
        'Session Context',
        () => new SessionContext({
          session,
          messageCatalog: options.messageCatalog,
          ...(toolRegistry === undefined ? {} : { toolRegistry }),
          signal: context.scope.signal,
        }),
        (active: SessionContext) => active.dispose(),
      )
      context.provide(key, value)
    },
  })
}

import { createCapabilityKey } from '../capability/key.js'
import type { CapabilityKey, ComponentContext, ComponentDefinition } from '../capability/types.js'
import type { Awaitable } from '../effect/types.js'
import type { SessionAgent } from './session-agent.js'

export const SessionAgentKey = createCapabilityKey<SessionAgent>('agent.session')
export interface SessionAgentComponentOptions {
  readonly label: string
  readonly requires: readonly CapabilityKey<unknown>[]
  readonly key?: CapabilityKey<SessionAgent>
  /** Construct fresh owned runners with this activation's Scope signal. Never start a Run during setup. */
  readonly create: (context: ComponentContext) => Awaitable<SessionAgent>
}

/** Effect owns the assembled Agent; declared dependencies remain alive until its cleanup settles. */
export function createSessionAgentComponent(options: SessionAgentComponentOptions): ComponentDefinition {
  const key = options.key ?? SessionAgentKey
  return { label: options.label, requires: options.requires, provides: [key], setup: async context => {
    const agent = await context.apply('Session Agent', () => options.create(context), agent => agent.dispose())
    context.provide(key, agent)
  } }
}

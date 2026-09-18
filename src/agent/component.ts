import { createCapabilityKey } from '../capability/key.js'
import type { CapabilityKey, ComponentContext, ComponentDefinition } from '../capability/types.js'
import type { Awaitable } from '../effect/types.js'
import { SessionAgent } from './session-agent.js'
import type { SessionAgentOptions } from './runtime-contract.js'

export const SessionAgentKey = createCapabilityKey<SessionAgent>('agent.session')
export interface SessionAgentComponentOptions {
  readonly label: string
  readonly requires: readonly CapabilityKey<unknown>[]
  readonly key?: CapabilityKey<SessionAgent>
  /** Construct fresh owned runners; the component binds Agent admission to its activation Scope. */
  readonly create: (context: ComponentContext) => Awaitable<Omit<SessionAgentOptions, 'scope'>>
}

/** Effect owns the assembled Agent; declared dependencies remain alive until its cleanup settles. */
export function createSessionAgentComponent(options: SessionAgentComponentOptions): ComponentDefinition {
  const key = options.key ?? SessionAgentKey
  return { label: options.label, requires: options.requires, provides: [key], setup: async context => {
    const agent = await context.apply('Session Agent', async () => {
      const configured = await options.create(context)
      try { return new SessionAgent({ ...configured, scope: context.scope }) }
      catch (error) {
        const released = await Promise.allSettled([configured.context.dispose(), configured.model.dispose(), ...(configured.tools === undefined ? [] : [configured.tools.dispose()])])
        const failures = released.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length > 0) throw new AggregateError([error, ...failures], 'Agent assembly and runner release failed')
        throw error
      }
    }, agent => agent.dispose())
    context.provide(key, agent)
  } }
}

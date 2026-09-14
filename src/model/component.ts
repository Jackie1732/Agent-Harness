import { createCapabilityKey } from '../capability/key.js'
import type { ComponentDefinition } from '../capability/types.js'
import type { Awaitable } from '../effect/types.js'
import type { ModelProvider } from './contract.js'

/** Import this object to share the capability identity; names do not grant access. */
export const ModelProviderKey = createCapabilityKey<ModelProvider>('model.provider')

export interface ModelProviderComponentOptions {
  readonly label: string
  /** Creates the provider/client owned by this activation, never a model request. */
  readonly create: () => Awaitable<ModelProvider>
}

/** Thin lifecycle assembly: the provider has one Effect owner and one published binding. */
export function createModelProviderComponent(options: ModelProviderComponentOptions): ComponentDefinition {
  const { label, create } = options
  if (typeof label !== 'string' || label.length === 0 || typeof create !== 'function') throw new TypeError('model provider component requires a label and factory')
  return {
    label, requires: [], provides: [ModelProviderKey],
    setup: async context => {
      const provider = await context.apply('model provider', create, active => active.dispose())
      context.provide(ModelProviderKey, provider)
    },
  }
}

import { createCapabilityKey } from '../capability/key.js'
import type { CapabilityKey, ComponentDefinition } from '../capability/types.js'
import type { Awaitable } from '../effect/types.js'
import type { ToolDefinition, ToolProvider, ToolSchemaLimits } from './contract.js'
import { ToolRegistry } from './registry.js'
import { readSchemaLimits } from './validation.js'

/** Optional shared key; callers may create another key for an isolated permission domain. */
export const ToolRegistryKey = createCapabilityKey<ToolRegistry>('tool.registry')

/** Publish one explicitly configured namespace. No Session or provider is implicitly created. */
export function createToolRegistryComponent(options: {
  readonly label: string
  readonly key: CapabilityKey<ToolRegistry>
  readonly limits: ToolSchemaLimits
}): ComponentDefinition {
  const { label, key } = options
  const limits = readSchemaLimits(options.limits)
  return {
    label, requires: [], provides: [key],
    setup: async context => {
      const registry = await context.apply('tool-registry', () => new ToolRegistry(limits), value => value.dispose())
      context.provide(key, registry)
    },
  }
}

/**
 * Create the provider first, register second: Effect LIFO retires the registration and waits
 * for its full invocations before releasing the provider. Staging visibility uses Scope.status.
 * Pass a definition created by createToolDefinition and a trusted provider factory.
 */
export function createToolProviderComponent(options: {
  readonly label: string
  readonly registryKey: CapabilityKey<ToolRegistry>
  readonly definition: ToolDefinition
  readonly createProvider: () => Awaitable<ToolProvider>
}): ComponentDefinition {
  const { label, registryKey, definition, createProvider } = options
  return {
    label, requires: [registryKey], provides: [],
    setup: async context => {
      const registry = context.require(registryKey)
      const scope = context.scope
      const provider = await context.apply('tool-provider', createProvider, value => value.dispose())
      await context.apply('tool-registration', () => registry.register(scope, definition, provider), value => value.dispose())
    },
  }
}

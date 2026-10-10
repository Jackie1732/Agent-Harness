import { expect, it } from 'vitest'
import { CapabilityRegistry } from '../../src/index.js'

it('publishes Registry shutdown before notifying Root cancellation observers', async () => {
  const registry = new CapabilityRegistry()
  let nested: Promise<void> | undefined
  let observedStatus: string | undefined
  registry.scope.signal.addEventListener('abort', () => {
    observedStatus = registry.status
    nested = registry.dispose()
  }, { once: true })
  try {
    const disposal = registry.dispose()
    expect(observedStatus).toBe('disposing')
    expect(nested).toBe(disposal)
    await disposal
    expect(registry.status).toBe('disposed')
  } finally {
    await registry.dispose()
    await nested
  }
})

it('publishes Component release before notifying its cancellation observers', async () => {
  const registry = new CapabilityRegistry()
  let nested: Promise<void> | undefined
  let cleanups = 0
  const component = registry.mount({
    label: 'cancelled component', requires: [], provides: [],
    setup: async context => {
      context.signal.addEventListener('abort', () => {
        nested = component.dispose()
      }, { once: true })
      await context.apply('resource', () => undefined, () => { cleanups += 1 })
    },
  })
  try {
    await registry.whenQuiescent()
    const disposal = component.dispose()
    expect(nested).toBe(disposal)
    await disposal
    expect(component.status).toBe('disposed')
    expect(cleanups).toBe(1)
  } finally {
    await registry.dispose()
    await nested
  }
})

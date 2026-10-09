import { describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../../src/index.js'
import { drainMicrotasks, settle } from '../helpers/deferred.js'

describe('Registry disposal with a small reconciliation budget', () => {
  it('limits ordinary reconciliation while releasing every active resource during disposal', async () => {
    const registry = new CapabilityRegistry({ maxReconciliationSteps: 1 })
    const acquired: number[] = []
    const cleaned: number[] = []
    const components = Array.from({ length: 3 }, (_, index) => registry.mount({
      label: `resource ${index}`, requires: [], provides: [],
      setup: async context => {
        await context.apply('resource', () => { acquired.push(index); return index }, value => { cleaned.push(value) })
      },
    }))
    const firstPass = await settle(registry.whenQuiescent())
    try {
      expect(firstPass).toMatchObject({ status: 'rejected', reason: { code: 'REGISTRY_NOT_CONVERGED', reason: 'step-limit' } })
      for (let pass = 0; pass < 4; pass += 1) await settle(registry.whenQuiescent())
      expect(components.map(component => component.status)).toEqual(['active', 'active', 'active'])
      const disposal = await settle(registry.dispose())
      await drainMicrotasks(100)
      expect(disposal).toEqual({ status: 'fulfilled', value: undefined })
      expect(registry.status).toBe('disposed')
      expect(cleaned).toEqual([2, 1, 0])
      expect(components.every(component => component.status === 'disposed')).toBe(true)
    } finally {
      await settle(registry.dispose())
      for (const component of components) await settle(component.dispose())
    }
    expect(acquired).toEqual([0, 1, 2])
    expect(cleaned).toHaveLength(acquired.length)
  })

  it('moves every failed Component to terminal state and rejects retry after disposal', async () => {
    const registry = new CapabilityRegistry({ maxReconciliationSteps: 1 })
    const components = Array.from({ length: 5 }, (_, index) => registry.mount({
      label: `failure ${index}`, requires: [], provides: [],
      setup: () => { throw new Error('activation failed') },
    }))
    try {
      for (let pass = 0; pass < 5; pass += 1) await settle(registry.whenQuiescent())
      expect(components.every(component => component.status === 'failed')).toBe(true)
      const disposal = await settle(registry.dispose())
      await drainMicrotasks(100)
      const terminal = components.at(-1)
      if (terminal === undefined) throw new Error('no failed Component was mounted')
      const retry = await settle(terminal.retry())
      expect(disposal).toEqual({ status: 'fulfilled', value: undefined })
      expect(registry.status).toBe('disposed')
      expect(retry).toMatchObject({ status: 'rejected', reason: { code: 'COMPONENT_INACTIVE', state: 'disposed' } })
      expect(components.every(component => component.status === 'disposed')).toBe(true)
    } finally {
      await settle(registry.dispose())
      for (const component of components) await settle(component.dispose())
    }
  })
})

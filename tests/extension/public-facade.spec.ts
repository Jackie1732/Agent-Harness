import { expect, it } from 'vitest'
import { CapabilityRegistry, createEventName } from '../../src/index.js'

it('keeps Root and child mutable runtime records outside the public facades', async () => {
  const registry = new CapabilityRegistry()
  const root = registry.scope
  const child = root.derive('public child')
  const event = createEventName<void>('facade.event')
  let calls = 0
  child.on(event, 'public listener', () => { calls += 1 })
  try {
    expect(Reflect.get(root, 'tree')).toBeUndefined()
    expect(Reflect.get(root, 'record')).toBeUndefined()
    expect(Reflect.get(child, 'tree')).toBeUndefined()
    expect(Reflect.get(child, 'record')).toBeUndefined()
    expect('dispose' in root).toBe(false)
    await root.emit(event, undefined)
    expect(calls).toBe(1)
    expect(registry.status).toBe('accepting')
    expect(root.status).toBe('accepting')
    expect(child.status).toBe('accepting')
  } finally { await registry.dispose() }
})

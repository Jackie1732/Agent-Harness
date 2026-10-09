import { expect, it } from 'vitest'
import { CapabilityRegistry } from '../../src/capability/registry.js'
import { ComponentActivationFailedError } from '../../src/capability/errors.js'

it('isolates returned failure details from the original error and later snapshots', async () => {
  const registry = new CapabilityRegistry()
  const handle = registry.mount({ label: 'ordinary error', requires: [], provides: [], setup() { throw new Error('ordinary setup failure') } })
  try {
    await registry.whenQuiescent()
    expect(handle.error).toBeInstanceOf(ComponentActivationFailedError)
    const failure = handle.error as ComponentActivationFailedError
    const details = registry.snapshot().components[0]!.failure!.details
    if (details === null || typeof details !== 'object') throw new Error('expected diagnostic details')
    Reflect.set(details, 'rollbackAttempted', 999)
    expect(failure.details?.rollbackAttempted).toBe(0)
    expect(failure.rollbackAttempted).toBe(0)
    expect(registry.snapshot().components[0]!.failure!.details).toMatchObject({ rollbackAttempted: 0 })
  } finally { await handle.dispose(); await registry.dispose() }
})

it('isolates returned JSON causes while preserving the original raw failure reason', async () => {
  const original = { reasonCode: 'ordinary-json-failure' }
  const registry = new CapabilityRegistry()
  const handle = registry.mount({ label: 'JSON reason', requires: [], provides: [], setup() { throw original } })
  try {
    await registry.whenQuiescent()
    const failure = handle.error as ComponentActivationFailedError
    expect(failure.reason).toBe(original)
    const cause = registry.snapshot().components[0]!.failure!.cause
    if (cause === null || typeof cause !== 'object') throw new Error('expected JSON cause')
    Reflect.set(cause, 'reasonCode', 'mutated snapshot')
    expect(original.reasonCode).toBe('ordinary-json-failure')
    expect(failure.reason).toBe(original)
    expect(registry.snapshot().components[0]!.failure!.cause).toMatchObject({ reasonCode: 'ordinary-json-failure' })
  } finally { await handle.dispose(); await registry.dispose() }
})

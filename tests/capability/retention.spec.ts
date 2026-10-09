import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import { createCapabilityKey } from '../../src/capability/key.js'
import { CapabilityRegistry } from '../../src/capability/registry.js'
import type { ComponentContext, ComponentHandle } from '../../src/capability/types.js'
import { ComponentActivationFailedError, ComponentDeactivationFailedError } from '../../src/capability/errors.js'
import { EffectDisposalFailedError, EffectRollbackFailedError } from '../../src/effect/errors.js'
import { createModelProviderComponent, ModelProviderKey } from '../../src/model/component.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'

const options = {
  providerId: 'retirement-provider', maxConcurrentExchanges: 1,
  streamLimits: { maxFrameBytes: 4096, maxStreamBytes: 16384, maxFrames: 32 },
  script: async function* () {},
}

it('retires terminal Model factories while their registry continues accepting Components', async () => {
  class Provider extends ScriptedModelProvider {}
  const registry = new CapabilityRegistry()
  function mount(): ComponentHandle {
    const provider = new Provider(options)
    return registry.mount(createModelProviderComponent({ label: 'model generation', create: () => provider }))
  }
  expect(queryObjects(Provider, { format: 'count' })).toBe(0)
  try {
    for (let index = 0; index < 20; index++) {
      const handle = mount()
      await registry.whenQuiescent()
      await handle.dispose()
    }
    await setImmediate()
    expect(queryObjects(Provider, { format: 'count' })).toBe(0)
    expect(registry.status).toBe('accepting')
    expect(registry.snapshot().providers).toEqual([])
    expect(registry.snapshot().components).toHaveLength(20)
  } finally { await registry.dispose() }
})

it('retires neighboring Model factories while a terminal diagnostic Handle remains reachable', async () => {
  class Provider extends ScriptedModelProvider {}
  async function makeTerminalHandle(): Promise<ComponentHandle> {
    const registry = new CapabilityRegistry()
    const handle = registry.mount({ label: 'diagnostic handle', requires: [], provides: [], setup() {} })
    function mountModel(): void {
      const provider = new Provider(options)
      registry.mount(createModelProviderComponent({ label: 'neighboring model', create: () => provider }))
    }
    mountModel()
    await registry.whenQuiescent()
    await registry.dispose()
    return handle
  }
  expect(queryObjects(Provider, { format: 'count' })).toBe(0)
  const handle = await makeTerminalHandle()
  await setImmediate()
  expect(queryObjects(Provider, { format: 'count' })).toBe(0)
  expect(handle.status).toBe('disposed')
  expect(handle.label).toBe('diagnostic handle')
  expect(handle.error).toBeUndefined()
  const released = handle.dispose()
  expect(handle.dispose()).toBe(released)
  await released
  await expect(handle.retry()).rejects.toMatchObject({ code: 'COMPONENT_INACTIVE', state: 'disposed' })
})

it('retires requirement values from a retained expired Context and preserves its inactive diagnostics', async () => {
  class Provider extends ScriptedModelProvider {}
  async function makeExpiredContext(): Promise<ComponentContext> {
    const registry = new CapabilityRegistry()
    registry.mount(createModelProviderComponent({ label: 'fresh model', create: () => new Provider(options) }))
    let captured: ComponentContext | undefined
    registry.mount({ label: 'context consumer', requires: [ModelProviderKey], provides: [], setup(context) {
      captured = context
      context.require(ModelProviderKey)
    } })
    await registry.whenQuiescent()
    await registry.dispose()
    if (captured === undefined) throw new Error('setup did not capture a Context')
    return captured
  }
  expect(queryObjects(Provider, { format: 'count' })).toBe(0)
  const context = await makeExpiredContext()
  await setImmediate()
  expect(queryObjects(Provider, { format: 'count' })).toBe(0)
  const inactive = expect.objectContaining({ code: 'COMPONENT_INACTIVE', state: 'settled', componentLabel: 'context consumer' })
  expect(() => context.require(ModelProviderKey)).toThrow(inactive)
  expect(() => context.signal).toThrow(inactive)
  expect(() => context.scope).toThrow(inactive)
  expect(() => context.provide(createCapabilityKey<undefined>('expired-context.offer'), undefined)).toThrow(inactive)
  let acquired = false
  await expect(context.apply('expired acquisition', () => { acquired = true }, () => {})).rejects.toMatchObject({
    code: 'COMPONENT_INACTIVE', state: 'settled', componentLabel: 'context consumer',
  })
  expect(acquired).toBe(false)
})

it('keeps a factory available for safe explicit retry and retires it only after terminal release', async () => {
  class FactoryState { attempts = 0 }
  const registry = new CapabilityRegistry(), reason = new Error('retryable setup failure')
  function mount(): ComponentHandle {
    const state = new FactoryState()
    return registry.mount({ label: 'retrying component', requires: [], provides: [], setup() {
      if (++state.attempts === 1) throw reason
    } })
  }
  expect(queryObjects(FactoryState, { format: 'count' })).toBe(0)
  const handle = mount()
  try {
    await registry.whenQuiescent()
    expect(handle.status).toBe('failed')
    expect(handle.error).toMatchObject({ reason })
    expect(registry.snapshot().components[0]).toMatchObject({ retryable: true })
    await setImmediate()
    expect(queryObjects(FactoryState, { format: 'count' })).toBe(1)
    await handle.retry()
    expect(handle.status).toBe('active')
    expect(handle.error).toBeUndefined()
    await handle.dispose()
    await setImmediate()
    expect(queryObjects(FactoryState, { format: 'count' })).toBe(0)
    expect(handle.status).toBe('disposed')
  } finally { await registry.dispose() }
})

it('leaves an explicitly captured provider value owned by its caller after Component release', async () => {
  class Provider extends ScriptedModelProvider {}
  async function makeCapturedValue(): Promise<Provider> {
    const registry = new CapabilityRegistry()
    let captured: Provider | undefined
    registry.mount(createModelProviderComponent({ label: 'caller value', create: () => new Provider(options) }))
    registry.mount({ label: 'value consumer', requires: [ModelProviderKey], provides: [], setup(context) {
      captured = context.require(ModelProviderKey) as Provider
    } })
    await registry.whenQuiescent()
    await registry.dispose()
    if (captured === undefined) throw new Error('setup did not capture a provider')
    return captured
  }
  expect(queryObjects(Provider, { format: 'count' })).toBe(0)
  const value = await makeCapturedValue()
  await setImmediate()
  expect(queryObjects(Provider, { format: 'count' })).toBe(1)
  expect(value.descriptor.providerId).toBe(options.providerId)
  await value.dispose()
})

it('preserves unsafe rollback reasons and terminal failure identity without repeating the inverse', async () => {
  const registry = new CapabilityRegistry()
  const setupReason = new Error('setup failed'), cleanupReason = new Error('rollback failed')
  let setups = 0, cleanups = 0
  const handle = registry.mount({ label: 'unsafe startup', requires: [], provides: [], setup: async context => {
    setups++
    await context.apply('owned resource', () => undefined, () => { cleanups++; throw cleanupReason })
    throw setupReason
  } })
  await registry.whenQuiescent()
  expect(handle.status).toBe('failed')
  const failure = handle.error as ComponentActivationFailedError
  expect(failure).toBeInstanceOf(ComponentActivationFailedError)
  expect(failure.reason).toBeInstanceOf(AggregateError)
  const reasons = (failure.reason as AggregateError).errors as unknown[]
  expect(reasons[0]).toBeInstanceOf(EffectRollbackFailedError)
  expect((reasons[0] as EffectRollbackFailedError).setupReason).toBe(setupReason)
  expect((reasons[0] as EffectRollbackFailedError).cleanupFailures[0]?.reason).toBe(cleanupReason)
  expect(reasons[1]).toBeInstanceOf(EffectDisposalFailedError)
  expect((reasons[1] as EffectDisposalFailedError).cleanupFailures[0]?.reason).toBe(cleanupReason)
  await expect(handle.retry()).rejects.toMatchObject({ code: 'COMPONENT_RETRY_UNSAFE' })
  const released = handle.dispose()
  await expect(released).rejects.toBe(failure)
  expect(handle.dispose()).toBe(released)
  expect(handle.status).toBe('disposed')
  expect(handle.error).toBe(failure)
  expect(registry.snapshot().components[0]).toMatchObject({ failurePhase: 'activation', failure: { code: 'COMPONENT_ACTIVATION_FAILED' } })
  await expect(registry.dispose()).rejects.toMatchObject({ errors: [failure] })
  expect(setups).toBe(1)
  expect(cleanups).toBe(1)
})

it('preserves the original cleanup reason and shared release failure after terminal deactivation', async () => {
  const registry = new CapabilityRegistry(), reason = new Error('deactivation cleanup failed')
  let cleanups = 0
  const handle = registry.mount({ label: 'failed deactivation', requires: [], provides: [], setup: async context => {
    await context.apply('owned resource', () => undefined, () => { cleanups++; throw reason })
  } })
  await registry.whenQuiescent()
  const released = handle.dispose()
  await expect(released).rejects.toBeInstanceOf(ComponentDeactivationFailedError)
  const failure = handle.error as ComponentDeactivationFailedError
  expect(failure.reason).toBeInstanceOf(EffectDisposalFailedError)
  expect((failure.reason as EffectDisposalFailedError).cleanupFailures[0]?.reason).toBe(reason)
  expect(handle.status).toBe('disposed')
  expect(handle.dispose()).toBe(released)
  expect(handle.error).toBe(failure)
  expect(registry.snapshot().components[0]).toMatchObject({ failurePhase: 'deactivation', failure: { code: 'COMPONENT_DEACTIVATION_FAILED' } })
  await expect(registry.dispose()).rejects.toMatchObject({ errors: [failure] })
  expect(cleanups).toBe(1)
})

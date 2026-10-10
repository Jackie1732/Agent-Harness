import { describe, expect, it } from 'vitest'
import { CapabilityRegistry, ScopeInactiveError, createEventName } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'

describe('scope cancellation handoff', () => {
  it('withdraws the entire subtree before cancellation observers run', async () => {
    const registry = new CapabilityRegistry()
    const parent = registry.scope.derive('parent')
    const child = parent.derive('child')
    const event = createEventName<void>('closing.admission')
    let calls = 0
    const registration = child.on(event, 'child listener', () => { calls += 1 })
    let observed: unknown
    let emission: Promise<void> | undefined
    let admissionFailure: unknown
    parent.signal.addEventListener('abort', () => {
      observed = { child: child.status, registration: registration.status }
      try { emission = child.emit(event, undefined) } catch (reason) { admissionFailure = reason }
    }, { once: true })

    try {
      await parent.dispose()
      await emission
      expect(observed).toEqual({ child: 'disposing', registration: 'disposed' })
      expect(admissionFailure).toBeInstanceOf(ScopeInactiveError)
      expect(calls).toBe(0)
    } finally { await registry.dispose() }
  })

  it('shares the disposal task with cancellation observers', async () => {
    const registry = new CapabilityRegistry()
    const parent = registry.scope.derive('parent')
    const child = parent.derive('child')
    let parentJoin: Promise<void> | undefined
    let childJoin: Promise<void> | undefined
    parent.signal.addEventListener('abort', () => {
      parentJoin = parent.dispose()
      childJoin = child.dispose()
    }, { once: true })

    try {
      const release = parent.dispose()
      expect(parentJoin).toBe(release)
      expect(childJoin).toBe(child.dispose())
      await release
      await childJoin
      expect(parent.status).toBe('disposed')
      expect(child.status).toBe('disposed')
    } finally { await registry.dispose() }
  })

  it('lets cancellation observers join the disposing barrier', async () => {
    const registry = new CapabilityRegistry()
    const scope = registry.scope.derive('observer barrier')
    let barrier: ReturnType<typeof scope.whenQuiescent> | undefined
    let waitFailure: unknown
    scope.signal.addEventListener('abort', () => {
      try { barrier = scope.whenQuiescent() } catch (reason) { waitFailure = reason }
    }, { once: true })

    try {
      await scope.dispose()
      expect(waitFailure).toBeUndefined()
      expect(barrier).toBeDefined()
      await expect(barrier).resolves.toMatchObject({ status: 'disposed', subtreeInFlight: 0 })
    } finally { await registry.dispose() }
  })

  it('keeps a cancellation observer join pending until admitted frames settle', async () => {
    const registry = new CapabilityRegistry()
    const parent = registry.scope.derive('parent')
    const child = parent.derive('frame owner')
    const event = createEventName<void>('closing.frame')
    const started = createDeferred<void>()
    const finish = createDeferred<void>()
    let join: Promise<void> | undefined
    let joined = false
    child.on(event, 'held frame', async () => {
      started.resolve(undefined)
      await finish.promise
    })
    parent.signal.addEventListener('abort', () => {
      join = child.dispose()
      void join.then(() => { joined = true })
    }, { once: true })
    const emission = registry.scope.emit(event, undefined)

    try {
      await started.promise
      const release = parent.dispose()
      await Promise.resolve()
      expect(joined).toBe(false)
      expect(child.snapshot().subtreeInFlight).toBe(1)
      finish.resolve(undefined)
      await emission
      await release
      await join
      expect(joined).toBe(true)
      expect(child.status).toBe('disposed')
    } finally {
      finish.resolve(undefined)
      await emission
      await registry.dispose()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { EffectOwner } from '../../src/index.js'
import { createDeferred, settle } from '../helpers/deferred.js'

describe('effect startup cancellation', () => {
  it('aborts a failed startup before joining its cooperative worker', async () => {
    const owner = new EffectOwner('failed-worker')
    const signal = createDeferred<AbortSignal>()
    const workerStopped = createDeferred<void>()
    const joining = createDeferred<void>()
    const reason = new Error('later setup failed')
    const trace: string[] = []
    const outcome = settle(owner.run('worker', async effect => {
      signal.resolve(effect.signal)
      effect.signal.addEventListener('abort', () => {
        trace.push('abort')
        workerStopped.resolve()
      }, { once: true })
      await effect.apply('worker', () => ({ join: () => workerStopped.promise }), async worker => {
        trace.push('join')
        joining.resolve()
        await worker.join()
        trace.push('joined')
      })
      throw reason
    }))

    try {
      await joining.promise
      expect((await signal.promise).aborted).toBe(true)
      expect(await outcome).toEqual({ status: 'rejected', reason })
      expect((await outcome as { reason: unknown }).reason).toBe(reason)
      expect(trace).toEqual(['abort', 'join', 'joined'])
      expect(owner.status).toBe('accepting')
    } finally {
      await owner.dispose()
      await outcome
    }
  })

  it('aborts and restores an admitted operation that setup did not await', async () => {
    const owner = new EffectOwner('failed-pending-acquisition')
    const signal = createDeferred<AbortSignal>()
    const started = createDeferred<void>()
    const acquisition = createDeferred<object>()
    const resource = {}
    const active = new Set<object>()
    const reason = new Error('setup failed while acquisition waited')
    const trace: string[] = []
    const outcome = settle(owner.run('pending', async effect => {
      signal.resolve(effect.signal)
      effect.signal.addEventListener('abort', () => {
        trace.push('abort')
        active.add(resource)
        acquisition.resolve(resource)
      }, { once: true })
      void effect.apply('acquire', () => {
        trace.push('started')
        started.resolve()
        return acquisition.promise
      }, value => {
        expect(value).toBe(resource)
        trace.push('reverted')
        active.delete(value)
      }).catch(() => undefined)
      await started.promise
      throw reason
    }))

    try {
      await started.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      expect((await signal.promise).aborted).toBe(true)
      expect(await outcome).toEqual({ status: 'rejected', reason })
      expect((await outcome as { reason: unknown }).reason).toBe(reason)
      expect(trace).toEqual(['started', 'abort', 'reverted'])
      expect(active.size).toBe(0)
      expect(owner.status).toBe('accepting')
    } finally {
      await owner.dispose()
      await outcome
    }
  })

  it('keeps a sibling active when one failed startup aborts', async () => {
    const owner = new EffectOwner('isolated-startup-abort')
    const siblingSignal = createDeferred<AbortSignal>()
    const failedSignal = createDeferred<AbortSignal>()
    const releases: string[] = []
    const sibling = await owner.run('sibling', async effect => {
      siblingSignal.resolve(effect.signal)
      await effect.apply('sibling resource', () => 'sibling', value => { releases.push(value) })
      return 'sibling'
    })
    const reason = new Error('only one setup failed')
    const outcome = settle(owner.run('failing', async effect => {
      failedSignal.resolve(effect.signal)
      await effect.apply('failed resource', () => 'failing', value => { releases.push(value) })
      throw reason
    }))

    try {
      expect(await outcome).toEqual({ status: 'rejected', reason })
      expect((await failedSignal.promise).aborted).toBe(true)
      expect((await siblingSignal.promise).aborted).toBe(false)
      expect(sibling.value).toBe('sibling')
      expect(releases).toEqual(['failing'])
      expect(owner.status).toBe('accepting')
      await sibling.dispose()
      expect((await siblingSignal.promise).aborted).toBe(true)
      expect(releases).toEqual(['failing', 'sibling'])
    } finally {
      await owner.dispose()
      await outcome
    }
  })

  it('starts an admitted operation before a following synchronous release', async () => {
    const owner = new EffectOwner('synchronous-forward-start')
    const started = createDeferred<void>()
    const acquisition = createDeferred<string>()
    const closing = createDeferred<Promise<void>>()
    const trace: string[] = []
    const outcome = settle(owner.run('resource', effect => {
      void effect.apply('acquire', () => {
        trace.push(effect.signal.aborted ? 'started-aborted' : 'started')
        started.resolve()
        return acquisition.promise
      }, value => { trace.push('reverted:' + value) }).catch(() => undefined)
      closing.resolve(owner.dispose())
      trace.push('release-requested')
      return 'setup'
    }))

    try {
      await started.promise
      expect(trace).toEqual(['started', 'release-requested'])
      acquisition.resolve('value')
      expect(await outcome).toMatchObject({ status: 'rejected', reason: { code: 'EFFECT_START_INTERRUPTED' } })
      await closing.promise
      expect(trace).toEqual(['started', 'release-requested', 'reverted:value'])
      expect(owner.status).toBe('disposed')
    } finally {
      acquisition.resolve('value')
      await owner.dispose()
      await outcome
    }
  })

  it('tracks an operation that synchronously requests its owner release', async () => {
    const owner = new EffectOwner('forward-release-reentry')
    const acquisition = createDeferred<object>()
    const started = createDeferred<void>()
    const closing = createDeferred<Promise<void>>()
    const resource = {}
    const active = new Set<object>()
    const trace: string[] = []
    let closed = false
    const outcome = settle(owner.run('resource', effect => effect.apply('acquire', () => {
      trace.push('started')
      const release = owner.dispose()
      void release.then(() => { closed = true })
      closing.resolve(release)
      started.resolve()
      trace.push(effect.signal.aborted ? 'aborted' : 'not-aborted')
      return acquisition.promise.then(value => {
        active.add(value)
        return value
      })
    }, value => {
      expect(value).toBe(resource)
      active.delete(value)
      trace.push('reverted')
    })))

    try {
      await started.promise
      expect(trace).toEqual(['started', 'aborted'])
      expect(closed).toBe(false)
      acquisition.resolve(resource)
      expect(await outcome).toMatchObject({ status: 'rejected', reason: { code: 'EFFECT_START_INTERRUPTED' } })
      await closing.promise
      expect(active.size).toBe(0)
      expect(trace).toEqual(['started', 'aborted', 'reverted'])
      expect(closed).toBe(true)
      expect(owner.status).toBe('disposed')
    } finally {
      acquisition.resolve(resource)
      await owner.dispose()
      await outcome
    }
  })
})

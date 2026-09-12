import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  EventListenersFailedError,
  createEventName,
} from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'

describe('event dispatch', () => {
  it('runs listeners serially in tree registration order', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<{ value: number }>('ordered')
    const child = registry.scope.derive('child')
    const firstStarted = createDeferred<void>()
    const firstFinished = createDeferred<void>()
    const trace: string[] = []
    child.on(event, 'first', async payload => {
      trace.push(`first:${payload.value}`)
      firstStarted.resolve(undefined)
      await firstFinished.promise
    })
    registry.scope.on(event, 'second', payload => {
      trace.push(`second:${payload.value}`)
    })

    const emission = registry.scope.emit(event, { value: 7 })
    await firstStarted.promise
    expect(trace).toEqual(['first:7'])
    firstFinished.resolve(undefined)
    await emission
    expect(trace).toEqual(['first:7', 'second:7'])
    await registry.dispose()
  })

  it('continues after failures and exposes ordered raw reasons', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('aggregate')
    const firstReason = new Error('first')
    const secondReason = { failure: 'second' }
    const trace: string[] = []
    registry.scope.on(event, 'first failure', () => {
      trace.push('first')
      throw firstReason
    })
    registry.scope.on(event, 'success', () => {
      trace.push('success')
    })
    registry.scope.on(event, 'second failure', () => {
      trace.push('second')
      throw secondReason
    })

    const outcome = await registry.scope.emit(event, undefined).catch(reason => reason as unknown)
    expect(trace).toEqual(['first', 'success', 'second'])
    expect(outcome).toBeInstanceOf(EventListenersFailedError)
    const failure = outcome as EventListenersFailedError
    expect(failure.failures.map(item => item.reason)).toEqual([firstReason, secondReason])
    expect(failure.details).toMatchObject({ attempted: 3, failed: 2 })
    expect(() => JSON.stringify(failure.toJSON())).not.toThrow()
    await registry.dispose()
  })

  it('uses an ordinal upper bound and skips registrations removed before their turn', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('mutating')
    const trace: string[] = []
    let later = registry.scope.on(event, 'later', () => {
      trace.push('later')
    })
    await later.dispose()
    registry.scope.on(event, 'first', async () => {
      trace.push('first')
      registry.scope.on(event, 'new', () => {
        trace.push('new')
      })
      await later.dispose()
    })
    later = registry.scope.on(event, 'removed before turn', () => {
      trace.push('removed')
    })

    await registry.scope.emit(event, undefined)
    expect(trace).toEqual(['first'])
    await registry.scope.emit(event, undefined)
    expect(trace).toEqual(['first', 'first', 'new'])
    await registry.dispose()
  })

  it('keeps the current frame but skips a scope closed before its listener starts', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('closing')
    const closing = registry.scope.derive('closing')
    const skipped = registry.scope.derive('skipped')
    const trace: string[] = []
    closing.on(event, 'closer', async () => {
      trace.push('closer:start')
      await skipped.dispose()
      trace.push('closer:end')
    })
    skipped.on(event, 'skipped', () => {
      trace.push('skipped')
    })

    await registry.scope.emit(event, undefined)
    expect(trace).toEqual(['closer:start', 'closer:end'])
    await registry.dispose()
  })

  it('allows independent nested dispatches of the same event', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<number>('nested')
    const trace: string[] = []
    registry.scope.on(event, 'first', async value => {
      trace.push(`first:${value}`)
      if (value === 0) await registry.scope.emit(event, 1)
    })
    registry.scope.on(event, 'second', value => {
      trace.push(`second:${value}`)
    })

    await registry.scope.emit(event, 0)
    expect(trace).toEqual(['first:0', 'first:1', 'second:1', 'second:0'])
    await expect(registry.scope.emit(createEventName('empty'), undefined)).resolves.toBeUndefined()
    await registry.dispose()
  })

  it('lets a current listener unregister itself without ending its frame', async () => {
    const registry = new CapabilityRegistry()
    const event = createEventName<void>('self.unregister')
    const trace: string[] = []
    let registration: ReturnType<typeof registry.scope.on<void>>
    registration = registry.scope.on(event, 'self', async () => {
      trace.push('before')
      await registration.dispose()
      trace.push('after')
    })
    registry.scope.on(event, 'next', () => {
      trace.push('next')
    })

    await registry.scope.emit(event, undefined)
    await registry.scope.emit(event, undefined)
    expect(trace).toEqual(['before', 'after', 'next', 'next'])
    await registry.dispose()
  })
})

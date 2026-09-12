import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  EventListenersFailedError,
  createEventName,
} from '../../src/index.js'

describe('extension model properties', () => {
  it('dispatches the active ordinal subsequence at most once for every disposal mask', async () => {
    for (let mask = 0; mask < 32; mask += 1) {
      const registry = new CapabilityRegistry()
      const event = createEventName<void>(`model.ordinal.${mask}`)
      const firstScope = registry.scope.derive('first')
      const secondScope = registry.scope.derive('second')
      const trace: number[] = []
      const registrations = Array.from({ length: 5 }, (_unused, index) => {
        const owner = index % 2 === 0 ? firstScope : secondScope
        return owner.on(event, `listener ${index}`, () => {
          trace.push(index)
        })
      })
      for (const [index, registration] of registrations.entries()) {
        if ((mask & (1 << index)) !== 0) await registration.dispose()
      }

      await registry.scope.emit(event, undefined)
      const expected = registrations.flatMap((_registration, index) =>
        (mask & (1 << index)) === 0 ? [index] : [])
      expect(trace).toEqual(expected)
      expect(new Set(trace).size).toBe(trace.length)
      await registry.dispose()
    }
  })

  it('projects listener failures in the same order as the actual call trace', async () => {
    for (let failureMask = 1; failureMask < 16; failureMask += 1) {
      const registry = new CapabilityRegistry()
      const event = createEventName<void>(`model.failures.${failureMask}`)
      const trace: number[] = []
      for (let index = 0; index < 4; index += 1) {
        registry.scope.on(event, `listener ${index}`, () => {
          trace.push(index)
          if ((failureMask & (1 << index)) !== 0) throw new Error(`failure ${index}`)
        })
      }

      const reason = await registry.scope.emit(event, undefined).catch(error => error as unknown)
      expect(trace).toEqual([0, 1, 2, 3])
      expect(reason).toBeInstanceOf(EventListenersFailedError)
      const aggregate = reason as EventListenersFailedError
      expect(aggregate.failures.map(failure => failure.listenerLabel)).toEqual(
        trace.flatMap(index => (failureMask & (1 << index)) !== 0 ? [`listener ${index}`] : []),
      )
      await registry.dispose()
    }
  })
})

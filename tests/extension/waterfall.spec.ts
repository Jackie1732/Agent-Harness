import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  MiddlewareNextInactiveError,
  MiddlewareNextRepeatedError,
  MiddlewareUnterminatedError,
  createMiddlewareName,
} from '../../src/index.js'
import type { MiddlewareNext } from '../../src/index.js'

describe('middleware waterfall', () => {
  it('replaces requests and transforms results around the terminal', async () => {
    const registry = new CapabilityRegistry()
    const middleware = createMiddlewareName<string, number>('transform')
    const trace: string[] = []
    registry.scope.intercept(middleware, 'outer', async (request, next) => {
      trace.push(`outer:before:${request}`)
      const result = await next(`${request}-outer`)
      trace.push(`outer:after:${result}`)
      return result + 1
    })
    registry.scope.intercept(middleware, 'inner', async (request, next) => {
      trace.push(`inner:before:${request}`)
      const result = await next()
      trace.push(`inner:after:${result}`)
      return result * 2
    })

    const result = await registry.scope.invoke(middleware, 'start', request => {
      trace.push(`terminal:${request}`)
      return 3
    })
    expect(result).toBe(7)
    expect(trace).toEqual([
      'outer:before:start',
      'inner:before:start-outer',
      'terminal:start-outer',
      'inner:after:3',
      'outer:after:6',
    ])
    await registry.dispose()
  })

  it('supports short circuits and calls a terminal directly with no handlers', async () => {
    const registry = new CapabilityRegistry()
    const short = createMiddlewareName<string, string>('short')
    registry.scope.intercept(short, 'short circuit', request => `stopped:${request}`)
    await expect(registry.scope.invoke(short, 'request')).resolves.toBe('stopped:request')

    const empty = createMiddlewareName<number, number>('empty')
    await expect(registry.scope.invoke(empty, 4, value => value * 2)).resolves.toBe(8)
    await registry.dispose()
  })

  it('reports an unterminated delegated chain', async () => {
    const registry = new CapabilityRegistry()
    const middleware = createMiddlewareName<void, void>('unterminated')
    registry.scope.intercept(middleware, 'delegate', (_request, next) => next())

    await expect(registry.scope.invoke(middleware, undefined))
      .rejects.toBeInstanceOf(MiddlewareUnterminatedError)
    await registry.dispose()
  })

  it('propagates downstream failures for an upstream handler to recover', async () => {
    const registry = new CapabilityRegistry()
    const middleware = createMiddlewareName<void, string>('recover')
    registry.scope.intercept(middleware, 'recovery', async (_request, next) => {
      try {
        return await next()
      } catch (reason) {
        expect(reason).toMatchObject({ message: 'downstream failed' })
        return 'recovered'
      }
    })
    registry.scope.intercept(middleware, 'failure', () => {
      throw new Error('downstream failed')
    })

    await expect(registry.scope.invoke(middleware, undefined)).resolves.toBe('recovered')
    await registry.dispose()
  })

  it('advances a handler downstream at most once', async () => {
    const registry = new CapabilityRegistry()
    const middleware = createMiddlewareName<void, number>('next.once')
    let terminalCalls = 0
    registry.scope.intercept(middleware, 'double next', async (_request, next) => {
      const first = next()
      const repeated = await next().catch(reason => reason as unknown)
      expect(repeated).toBeInstanceOf(MiddlewareNextRepeatedError)
      return await first
    })

    await expect(registry.scope.invoke(middleware, undefined, () => {
      terminalCalls += 1
      return 1
    })).resolves.toBe(1)
    expect(terminalCalls).toBe(1)
    await registry.dispose()
  })

  it('refuses a saved next after its handler settled', async () => {
    const registry = new CapabilityRegistry()
    const middleware = createMiddlewareName<string, number>('next.late')
    let saved: MiddlewareNext<string, number> | undefined
    let terminalCalls = 0
    registry.scope.intercept(middleware, 'save next', (_request, next) => {
      saved = next
      return 5
    })

    await expect(registry.scope.invoke(middleware, 'request', () => {
      terminalCalls += 1
      return 1
    })).resolves.toBe(5)
    const late = saved
    if (late === undefined) throw new Error('handler did not expose next')
    await expect(late()).rejects.toBeInstanceOf(MiddlewareNextInactiveError)
    expect(terminalCalls).toBe(0)
    await registry.dispose()
  })

  it('selects downstream lazily while preserving the invocation upper bound', async () => {
    const registry = new CapabilityRegistry()
    const middleware = createMiddlewareName<void, string>('lazy')
    const trace: string[] = []
    let removed = registry.scope.intercept(middleware, 'placeholder', () => 'placeholder')
    await removed.dispose()
    registry.scope.intercept(middleware, 'first', async (_request, next) => {
      trace.push('first')
      registry.scope.intercept(middleware, 'new', async (_newRequest, newNext) => {
        trace.push('new')
        return await newNext()
      })
      await removed.dispose()
      return await next()
    })
    removed = registry.scope.intercept(middleware, 'removed', () => {
      trace.push('removed')
      return 'removed'
    })

    await expect(registry.scope.invoke(middleware, undefined, () => 'terminal'))
      .resolves.toBe('terminal')
    expect(trace).toEqual(['first'])
    await expect(registry.scope.invoke(middleware, undefined, () => 'terminal'))
      .resolves.toBe('terminal')
    expect(trace).toEqual(['first', 'first', 'new'])
    await registry.dispose()
  })

  it('keeps a current handler alive while skipping a closed downstream scope', async () => {
    const registry = new CapabilityRegistry()
    const middleware = createMiddlewareName<void, string>('close.downstream')
    const first = registry.scope.derive('first')
    const skipped = registry.scope.derive('skipped')
    const trace: string[] = []
    first.intercept(middleware, 'closer', async (_request, next) => {
      trace.push('closer:start')
      await skipped.dispose()
      const result = await next()
      trace.push('closer:end')
      return result
    })
    skipped.intercept(middleware, 'skipped', () => {
      trace.push('skipped')
      return 'skipped'
    })

    await expect(registry.scope.invoke(middleware, undefined, () => 'terminal'))
      .resolves.toBe('terminal')
    expect(trace).toEqual(['closer:start', 'closer:end'])
    await registry.dispose()
  })

  it('continues the current handler after it starts closing its own scope', async () => {
    const registry = new CapabilityRegistry()
    const middleware = createMiddlewareName<void, string>('close.current')
    const current = registry.scope.derive('current')
    const trace: string[] = []
    current.intercept(middleware, 'self closer', async (_request, next) => {
      trace.push('before')
      const closeFailure = await current.dispose().catch(reason => reason as unknown)
      expect(closeFailure).toMatchObject({ code: 'SCOPE_REENTRANT_WAIT' })
      const result = await next()
      trace.push('after')
      return result
    })

    await expect(registry.scope.invoke(middleware, undefined, () => 'terminal'))
      .resolves.toBe('terminal')
    await current.dispose()
    expect(trace).toEqual(['before', 'after'])
    await registry.dispose()
  })
})

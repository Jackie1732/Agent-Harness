import { describe, expect, it } from 'vitest'
import {
  SessionContext,
  SessionModelRunner,
  assembleContext,
  projectContextSession,
  readAssembly,
  rebuildAssembly,
} from '../../src/index.js'
import { emptyMessageCatalog, profile, repository, runnerLimits, scriptedModel, selection } from './fixtures.js'
import { contextInputRecordedEvent } from '../../src/context/session-events.js'
import { canonicalJsonBytes } from '../../src/foundation/canonical-json.js'

const input = (text: string) => ({ kind: 'user' as const, origin: 'host-authored' as const, originLabel: 'test', text })

describe('Context assembly and Model adoption', () => {
  it('commits a deterministic request and rebuilds it from saved facts alone', async () => {
    const repo = repository()
    const provider = scriptedModel()
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile())
      const recordedInput = await context.recordInput(input('你好 ${HOME}'))
      const requestSelection = selection(recordedProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
      })
      const cut = handle.snapshot()
      const committed = await context.assemble(requestSelection)
      expect(committed.kind).toBe('ready')
      if (committed.kind !== 'ready') throw new Error('expected ready assembly')
      expect(committed.request).toEqual({
        model: 'fixture-model',
        instructions: ['Answer precisely.'],
        messages: [{ role: 'user', content: [{ kind: 'text', text: '你好 ${HOME}' }] }],
        tools: [],
        maxOutputTokens: 256,
      })
      expect(committed.inputPrecondition.expectedLocalPosition).toBe(committed.committed.stored.sequence)
      expect(committed.committedEnvelopeBytes).toBeGreaterThan(0)
      expect(committed.committed.payload.budget.requestBytes).toBe(canonicalJsonBytes(committed.request).byteLength)
      expect(committed.committed.payload.budget.estimatedInputTokens).toBe(
        Math.ceil(canonicalJsonBytes(committed.request).byteLength / 4) + 8,
      )
      const pure = assembleContext({
        snapshot: cut,
        profile: recordedProfile,
        selection: requestSelection,
        captured: committed.committed.payload.captured,
        sessionMaxRecordBytes: handle.maxRecordBytes,
      })
      expect(pure).toMatchObject({ kind: 'ready', assembly: committed.committed.payload, request: committed.request })
      expect(rebuildAssembly(handle.snapshot(), committed.committed.stored.eventId)).toMatchObject({
        kind: 'rebuilt', request: committed.request, adoption: { kind: 'not-yet-adopted' },
      })

      const runner = new SessionModelRunner({ session: handle, provider, limits: runnerLimits })
      await runner.invoke(committed.request, { inputPrecondition: committed.inputPrecondition })
      expect(readAssembly(handle.snapshot(), committed.committed.stored.eventId).adoption).toMatchObject({ kind: 'adopted' })
      expect(rebuildAssembly(handle.snapshot(), committed.committed.stored.eventId)).toMatchObject({ kind: 'rebuilt' })
      await runner.dispose()
      await context.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('rejects stale Context input before provider preparation or external emission', async () => {
    const counters = { prepare: 0, acquire: 0, start: 0 }
    const provider = scriptedModel('unused', counters)
    const repo = repository()
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile())
      const first = await context.recordInput(input('first'))
      const assembled = await context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: first.stored.eventId, selector: 'user-input' }],
      }))
      if (assembled.kind !== 'ready') throw new Error('expected ready assembly')
      await context.recordInput(input('intervening local fact'))
      const runner = new SessionModelRunner({ session: handle, provider, limits: runnerLimits })
      await expect(runner.invoke(assembled.request, { inputPrecondition: assembled.inputPrecondition })).rejects.toMatchObject({
        code: 'MODEL_INPUT_STALE',
      })
      expect(counters).toEqual({ prepare: 0, acquire: 0, start: 0 })
      expect(projectContextSession(handle.snapshot()).assemblies[0]!.adoption).toMatchObject({
        kind: 'not-adopted-at-next-event',
      })
      expect(runner.status).toBe('accepting')
      await runner.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('rejects a mismatched provider precondition before provider preparation', async () => {
    const counters = { prepare: 0, acquire: 0, start: 0 }
    const provider = scriptedModel('unused', counters)
    const repo = repository()
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile())
      const recordedInput = await context.recordInput(input('provider-bound cut'))
      const assembled = await context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
      }))
      if (assembled.kind !== 'ready') throw new Error('expected ready assembly')
      const runner = new SessionModelRunner({ session: handle, provider, limits: runnerLimits })
      await expect(runner.invoke(assembled.request, {
        inputPrecondition: {
          ...assembled.inputPrecondition,
          expectedProviderDescriptor: {
            ...assembled.inputPrecondition.expectedProviderDescriptor,
            providerId: 'different-provider',
          },
        },
      })).rejects.toMatchObject({ code: 'MODEL_INPUT_STALE' })
      expect(counters).toEqual({ prepare: 0, acquire: 0, start: 0 })
      expect(handle.snapshot().localPosition).toBe(assembled.committed.stored.sequence)
      expect(runner.status).toBe('accepting')
      await runner.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('returns estimator-unavailable as data and writes no Assembly', async () => {
    const provider = scriptedModel()
    const repo = repository()
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile('generation', {
        tokenAccounting: {
          mode: 'exact-required', algorithm: 'neutral-json-utf8-estimate/v1',
          bytesPerEstimatedToken: 4, fixedOverheadEstimate: 8,
        },
      }))
      const recordedInput = await context.recordInput(input('blocked'))
      const before = handle.snapshot().localPosition
      await expect(context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
      }))).resolves.toEqual({ kind: 'blocked', reason: 'estimator-unavailable', references: [] })
      expect(handle.snapshot().localPosition).toBe(before)
      expect(context.status).toBe('accepting')
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('lets exactly one of two Runners claim the same committed Assembly position', async () => {
    const provider = scriptedModel('one winner')
    const repo = repository()
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile())
      const recordedInput = await context.recordInput(input('shared cut'))
      const assembled = await context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
      }))
      if (assembled.kind !== 'ready') throw new Error('expected ready assembly')
      const first = new SessionModelRunner({ session: handle, provider, limits: runnerLimits })
      const second = new SessionModelRunner({ session: handle, provider, limits: runnerLimits })
      const outcomes = await Promise.allSettled([
        first.invoke(assembled.request, { inputPrecondition: assembled.inputPrecondition }),
        second.invoke(assembled.request, { inputPrecondition: assembled.inputPrecondition }),
      ])
      expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(item => item.status === 'rejected')[0]).toMatchObject({ reason: { code: 'MODEL_INPUT_STALE' } })
      expect(readAssembly(handle.snapshot(), assembled.committed.stored.eventId).adoption).toMatchObject({ kind: 'adopted' })
      await Promise.all([first.dispose(), second.dispose()])
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('rechecks the CP0 position after provider preparation mutates the Session', async () => {
    const counters = { prepare: 0, acquire: 0, start: 0 }
    let handle: Awaited<ReturnType<ReturnType<typeof repository>['create']>> | undefined
    const provider = scriptedModel('unused', counters)
    const repo = repository()
    try {
      handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile())
      const recordedInput = await context.recordInput(input('race cut'))
      const assembled = await context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
      }))
      if (assembled.kind !== 'ready') throw new Error('expected ready assembly')
      const racingProvider = scriptedModel('unused', counters)
      const originalPrepare = racingProvider.prepare.bind(racingProvider)
      const providerWithWrite = {
        descriptor: racingProvider.descriptor,
        prepare: (request: Parameters<typeof originalPrepare>[0]) => {
          const prepared = originalPrepare(request)
          void handle!.append(contextInputRecordedEvent, input('inserted during prepare'))
          return prepared
        },
        dispose: () => racingProvider.dispose(),
      }
      // The provider descriptor is identical, so only the local position can invalidate CP0.
      const compatible = { ...assembled.inputPrecondition, expectedProviderDescriptor: providerWithWrite.descriptor }
      const runner = new SessionModelRunner({ session: handle, provider: providerWithWrite, limits: runnerLimits })
      await expect(runner.invoke(assembled.request, { inputPrecondition: compatible })).rejects.toMatchObject({ code: 'MODEL_INPUT_STALE' })
      expect(counters).toEqual({ prepare: 1, acquire: 0, start: 0 })
      expect(runner.status).toBe('accepting')
      await runner.dispose()
      await providerWithWrite.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })
})

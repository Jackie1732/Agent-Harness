import { describe, expect, it } from 'vitest'
import {
  SessionContext,
  SessionModelRunner,
  readAssembly,
  rebuildAssembly,
} from '../../src/index.js'
import { emptyMessageCatalog, profile, repository, runnerLimits, scriptedModel, selection } from './fixtures.js'

const userInput = (text: string) => ({ kind: 'user' as const, origin: 'host-authored' as const, originLabel: 'test', text })

describe('Context compaction', () => {
  it('does not write a Compaction when its complete rendered note is not smaller', async () => {
    const repo = repository()
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile())
      const source = await context.recordInput(userInput('small'))
      const before = handle.snapshot().localPosition
      const result = await context.compact({
        profileEventId: recordedProfile.stored.eventId,
        history: { mode: 'local-suffix', representation: 'raw' },
        units: [{ eventId: source.stored.eventId, selector: 'user-input' }],
        protectedRefs: [],
        maxExcerptBytes: 32,
      })
      expect(result).toMatchObject({ kind: 'not-beneficial' })
      expect(handle.snapshot().localPosition).toBe(before)
      expect(context.snapshot().compactions).toEqual([])
    } finally {
      await repo.dispose()
    }
  })

  it('commits a measured excerpt and substitutes its exact leaves in a later Assembly', async () => {
    const repo = repository()
    const provider = scriptedModel()
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile())
      const first = await context.recordInput(userInput(`alpha-${'研究🙂'.repeat(700)}`))
      const second = await context.recordInput(userInput(`beta-${'context'.repeat(600)}`))
      const request = {
        profileEventId: recordedProfile.stored.eventId,
        history: { mode: 'local-suffix' as const, representation: 'raw' as const },
        units: [
          { eventId: first.stored.eventId, selector: 'user-input' as const },
          { eventId: second.stored.eventId, selector: 'user-input' as const },
        ],
        protectedRefs: [],
        maxExcerptBytes: 24,
      }
      const preview = context.previewCompaction(request)
      expect(preview.kind).toBe('ready')
      if (preview.kind !== 'ready') throw new Error('expected beneficial compaction')
      expect(preview.compaction.compactedRenderedBytes).toBeLessThan(preview.compaction.originalRenderedBytes)
      expect(preview.compaction.summary).not.toContain('\uFFFD')
      const originalPrefix = JSON.stringify(handle.snapshot().history[0]!.events)
      const compacted = await context.compact(request)
      expect(compacted.kind).toBe('committed')
      if (compacted.kind !== 'committed') throw new Error('expected committed compaction')
      expect(JSON.stringify(handle.snapshot().history[0]!.events.slice(0, -1))).toBe(originalPrefix)

      const assembled = await context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
        compactions: [compacted.committed.stored.eventId],
      }))
      expect(assembled.kind).toBe('ready')
      if (assembled.kind !== 'ready') throw new Error('expected ready assembly')
      expect(assembled.committed.payload.selected.map(item => item.reference.selector)).toContain('compacted-history')
      expect(assembled.committed.payload.omitted).toMatchObject([
        { reference: { eventId: first.stored.eventId }, reason: 'compacted' },
        { reference: { eventId: second.stored.eventId }, reason: 'compacted' },
      ])
      expect(readAssembly(handle.snapshot(), assembled.committed.stored.eventId).adoption).toEqual({ kind: 'not-yet-adopted' })
      expect(rebuildAssembly(handle.snapshot(), assembled.committed.stored.eventId)).toMatchObject({
        kind: 'rebuilt', request: assembled.request,
      })
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('adopts only the text of an adjacent, clean model summary', async () => {
    const repo = repository()
    const provider = scriptedModel('short model summary')
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const compactionProfile = await context.recordProfile(profile('compaction'))
      const source = await context.recordInput(userInput('large source '.repeat(1000)))
      const prepared = await context.prepareCompactionInput(selection(compactionProfile.stored.eventId, provider.descriptor, {
        compactionSource: {
          units: [{ eventId: source.stored.eventId, selector: 'user-input' }],
          protectedRefs: [],
        },
      }))
      expect(prepared.kind).toBe('ready')
      if (prepared.kind !== 'ready') throw new Error('expected compaction input')
      const runner = new SessionModelRunner({ session: handle, provider, limits: runnerLimits })
      const settlement = await runner.invoke(prepared.request, { inputPrecondition: prepared.inputPrecondition })
      const adopted = await context.adoptModelCompaction(settlement.payload.invocationId, [])
      expect(adopted.kind).toBe('committed')
      if (adopted.kind !== 'committed') throw new Error('expected adopted compaction')
      expect(adopted.committed.payload.summary).toBe('short model summary')
      expect(adopted.committed.payload.algorithm).toMatchObject({
        kind: 'model-text', invocationId: settlement.payload.invocationId, blockIndices: [0],
      })
      expect(adopted.committed.payload.losses).toMatchObject([
        { kind: 'omitted-with-reason', reference: { eventId: source.stored.eventId } },
      ])
      await runner.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('protects an entire source closure across selectors', async () => {
    const repo = repository()
    const provider = scriptedModel('normal response '.repeat(200))
    try {
      const handle = await repo.create()
      const runner = new SessionModelRunner({ session: handle, provider, limits: runnerLimits })
      const settlement = await runner.invoke({
        model: 'fixture-model', instructions: [],
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'produce history' }] }],
        tools: [], maxOutputTokens: 256,
      })
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile())
      expect(() => context.previewCompaction({
        profileEventId: recordedProfile.stored.eventId,
        history: { mode: 'local-suffix', representation: 'raw' },
        units: [{ eventId: settlement.stored.eventId, selector: 'assistant-response' }],
        protectedRefs: [{ eventId: settlement.stored.eventId, selector: 'diagnostic' }],
        maxExcerptBytes: 32,
      })).toThrowError(expect.objectContaining({ code: 'CONTEXT_SOURCE_INVALID' }))
      await runner.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('does not adopt a matching summary when another fact separates Assembly and Model CP0', async () => {
    const repo = repository()
    const provider = scriptedModel('detached summary')
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const compactionProfile = await context.recordProfile(profile('compaction'))
      const source = await context.recordInput(userInput('source '.repeat(1000)))
      const prepared = await context.prepareCompactionInput(selection(compactionProfile.stored.eventId, provider.descriptor, {
        compactionSource: { units: [{ eventId: source.stored.eventId, selector: 'user-input' }], protectedRefs: [] },
      }))
      if (prepared.kind !== 'ready') throw new Error('expected compaction input')
      await context.recordInput(userInput('intervening fact'))
      const runner = new SessionModelRunner({ session: handle, provider, limits: runnerLimits })
      const settlement = await runner.invoke(prepared.request)
      const before = handle.snapshot().localPosition
      await expect(context.adoptModelCompaction(settlement.payload.invocationId, [])).rejects.toMatchObject({
        code: 'CONTEXT_SOURCE_INVALID',
      })
      expect(handle.snapshot().localPosition).toBe(before)
      await runner.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })
})

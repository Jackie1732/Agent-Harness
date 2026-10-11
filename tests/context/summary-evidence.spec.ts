import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileSessionBackend,
  ScriptedModelProvider,
  SessionContext,
  SessionModelRunner,
  createDeepSeekModelProvider,
  projectContextSession,
  rebuildAssembly,
} from '../../src/index.js'
import type { ModelFrame, ModelProvider, ModelRequestProfile, ModelStopReason, SessionHandle } from '../../src/index.js'
import { emptyMessageCatalog, profile, repository, runnerLimits, selection } from './fixtures.js'
import { httpFixture, sse, streamLimits } from '../model/fixtures.js'

function textFrames(texts: readonly string[], stopReason: ModelStopReason = 'stop'): ModelFrame[] {
  const frames: ModelFrame[] = [
    { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'summary-evidence' },
  ]
  for (const [index, text] of texts.entries()) frames.push(
    { kind: 'block-start', index, block: 'text' },
    { kind: 'text-delta', index, text },
    { kind: 'block-end', index },
  )
  frames.push({ kind: 'complete', stopReason })
  return frames
}

function summaryProvider(frames: readonly ModelFrame[], onClose?: () => void): ScriptedModelProvider {
  return new ScriptedModelProvider({
    providerId: 'context-summary-evidence', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16_384, maxStreamBytes: 262_144, maxFrames: 1000 },
    script: async function* () { yield* frames },
    ...(onClose === undefined ? {} : { onClose }),
  })
}

async function prepareSummary(handle: SessionHandle, context: SessionContext, provider: ModelProvider, modelProfile?: ModelRequestProfile) {
  const recordedProfile = await context.recordProfile(profile('compaction'))
  const source = await context.recordInput({
    kind: 'user', origin: 'host-authored', originLabel: 'summary fixture', text: 'large source '.repeat(1000),
  })
  const input = await context.prepareCompactionInput(selection(recordedProfile.stored.eventId, provider.descriptor, {
    target: { model: 'fixture-model', maxOutputTokens: 256, provider: provider.descriptor,
      ...(modelProfile === undefined ? {} : { profile: modelProfile }) },
    compactionSource: { units: [{ eventId: source.stored.eventId, selector: 'user-input' }], protectedRefs: [] },
  }))
  if (input.kind !== 'ready') throw new Error('expected prepared summary input')
  const runner = new SessionModelRunner({ session: handle, provider, limits: runnerLimits })
  return { runner, source, input }
}

describe('Model summary adoption evidence', () => {
  it.each(['length', 'refusal', 'content-filter'] as const)('keeps a %s result as Model evidence without adopting its complete text', async stopReason => {
    const repo = repository()
    const provider = summaryProvider(textFrames(['bounded text'], stopReason))
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const { runner, input } = await prepareSummary(handle, context, provider)
      const settlement = await runner.invoke(input.request, { inputPrecondition: input.inputPrecondition })
      expect(settlement.payload.result).toMatchObject({ protocolComplete: true, stopReason })
      const before = handle.snapshot().localPosition
      await expect(context.adoptModelCompaction(settlement.payload.invocationId, [])).rejects.toMatchObject({
        code: 'CONTEXT_SOURCE_INVALID',
      })
      expect(handle.snapshot().localPosition).toBe(before)
      expect(context.snapshot().compactions).toEqual([])
      expect(context.status).toBe('accepting')
      await runner.dispose()
      await context.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('requires text-only evidence even when the Model stopped cleanly with a continuation', async () => {
    const chunk = (delta: object, finish: string | null = null) => sse('', {
      id: 'context-summary-continuation', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
    const fixture = await httpFixture(response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(chunk({ reasoning_content: 'private continuation' })
        + chunk({ content: 'public summary' }, 'stop') + sse('', '[DONE]'))
    })
    const repo = repository()
    const provider = createDeepSeekModelProvider({
      providerId: 'context-summary-evidence', endpoint: fixture.endpoint, apiKey: 'fixture-key',
      maxConcurrentExchanges: 1, streamLimits,
    })
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const { runner, input } = await prepareSummary(handle, context, provider, {
        namespace: 'deepseek.chat', version: 1, options: { thinking: 'enabled' },
      })
      const settlement = await runner.invoke(input.request, { inputPrecondition: input.inputPrecondition })
      expect(settlement.payload).toMatchObject({ outcome: 'completed', result: { stopReason: 'stop' } })
      expect(settlement.payload.result.blocks.map(block => block.kind)).toEqual(['continuation', 'text'])
      const before = handle.snapshot().localPosition
      await expect(context.adoptModelCompaction(settlement.payload.invocationId, [])).rejects.toMatchObject({
        code: 'CONTEXT_SOURCE_INVALID',
      })
      expect(handle.snapshot().localPosition).toBe(before)
      await runner.dispose()
      await context.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
      await fixture.close()
    }
  })

  it('does not promote a closed text block from an incomplete transport', async () => {
    const frames = textFrames(['closed text without protocol completion'])
    frames.pop()
    const repo = repository()
    const provider = summaryProvider(frames)
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const { runner, input } = await prepareSummary(handle, context, provider)
      const settlement = await runner.invoke(input.request, { inputPrecondition: input.inputPrecondition })
      expect(settlement.payload).toMatchObject({ outcome: 'failed', result: { protocolComplete: false } })
      expect(settlement.payload.result.blocks[0]).toMatchObject({ kind: 'text', complete: true })
      const before = handle.snapshot().localPosition
      await expect(context.adoptModelCompaction(settlement.payload.invocationId, [])).rejects.toMatchObject({
        code: 'CONTEXT_SOURCE_INVALID',
      })
      expect(handle.snapshot().localPosition).toBe(before)
      await runner.dispose()
      await context.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('leaves a Model tool intent unexecuted and refuses to adopt it as a summary', async () => {
    const frames = textFrames(['tool request is not summary text'])
    frames.splice(-1, 1,
      { kind: 'block-start', index: 1, block: 'tool-call', callId: 'summary-call', name: 'unadvertised_tool' },
      { kind: 'arguments-delta', index: 1, text: '{}' },
      { kind: 'block-end', index: 1 },
      { kind: 'complete', stopReason: 'tool-calls' },
    )
    const repo = repository()
    const provider = summaryProvider(frames)
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const { runner, input } = await prepareSummary(handle, context, provider)
      const settlement = await runner.invoke(input.request, { inputPrecondition: input.inputPrecondition })
      expect(input.request.tools).toEqual([])
      expect(settlement.payload).toMatchObject({ outcome: 'completed', result: { stopReason: 'tool-calls' } })
      const before = handle.snapshot().localPosition
      await expect(context.adoptModelCompaction(settlement.payload.invocationId, [])).rejects.toMatchObject({
        code: 'CONTEXT_SOURCE_INVALID',
      })
      expect(handle.snapshot().localPosition).toBe(before)
      expect(handle.snapshot().history[0]!.events.some(event => event.stored.type.startsWith('tool/'))).toBe(false)
      await runner.dispose()
      await context.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('rechecks an explicit source protection added after Model summary generation', async () => {
    const repo = repository()
    const provider = summaryProvider(textFrames(['clean summary']))
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const { runner, input, source } = await prepareSummary(handle, context, provider)
      const settlement = await runner.invoke(input.request, { inputPrecondition: input.inputPrecondition })
      const before = handle.snapshot().localPosition
      await expect(context.adoptModelCompaction(settlement.payload.invocationId, [
        { eventId: source.stored.eventId, selector: 'user-input' },
      ])).rejects.toMatchObject({ code: 'CONTEXT_SOURCE_INVALID' })
      expect(handle.snapshot().localPosition).toBe(before)
      expect(context.snapshot().compactions).toEqual([])
      await runner.dispose()
      await context.dispose()
    } finally {
      await provider.dispose()
      await repo.dispose()
    }
  })

  it('preserves Model cleanup failure and refuses to adopt otherwise complete summary text', async () => {
    const failure = new Error('summary exchange close failed')
    const repo = repository()
    const provider = summaryProvider(textFrames(['complete summary']), () => { throw failure })
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const { runner, input } = await prepareSummary(handle, context, provider)
      await expect(runner.invoke(input.request, { inputPrecondition: input.inputPrecondition })).rejects.toMatchObject({
        code: 'MODEL_CLEANUP_FAILED',
      })
      const invocation = runner.snapshot().invocations[0]
      if (invocation?.state !== 'settled') throw new Error('expected durable failed summary settlement')
      const settlement = invocation.settled
      expect(settlement.payload).toMatchObject({
        outcome: 'failed', result: { protocolComplete: true, stopReason: 'stop' }, cleanup: { status: 'incomplete' },
      })
      const before = handle.snapshot().localPosition
      await expect(context.adoptModelCompaction(settlement.payload.invocationId, [])).rejects.toMatchObject({
        code: 'CONTEXT_SOURCE_INVALID',
      })
      expect(handle.snapshot().localPosition).toBe(before)
      await expect(runner.dispose()).rejects.toMatchObject({ code: 'MODEL_CLEANUP_FAILED' })
      await context.dispose()
    } finally {
      await expect(provider.dispose()).rejects.toMatchObject({ code: 'MODEL_CLEANUP_FAILED' })
      await repo.dispose()
    }
  })

  it('does not commit an empty summary or a summary with no byte savings', async () => {
    for (const text of [' \n\t ', 'long summary '.repeat(1100)]) {
      const repo = repository()
      const provider = summaryProvider(textFrames([text]))
      try {
        const handle = await repo.create()
        const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
        const { runner, input } = await prepareSummary(handle, context, provider)
        const settlement = await runner.invoke(input.request, { inputPrecondition: input.inputPrecondition })
        const before = handle.snapshot().localPosition
        if (text.trim().length === 0) await expect(context.adoptModelCompaction(settlement.payload.invocationId, [])).rejects.toMatchObject({
          code: 'CONTEXT_SOURCE_INVALID',
        })
        else await expect(context.adoptModelCompaction(settlement.payload.invocationId, [])).resolves.toMatchObject({ kind: 'not-beneficial' })
        expect(handle.snapshot().localPosition).toBe(before)
        expect(context.snapshot().compactions).toEqual([])
        await runner.dispose()
        await context.dispose()
      } finally {
        await provider.dispose()
        await repo.dispose()
      }
    }
  })

  it('rebuilds a multi-block adopted summary and its later Assembly from an independent File repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-context-summary-evidence-'))
    const options = { root, maxRecordBytes: 2 * 1024 * 1024 }
    const provider = summaryProvider(textFrames(['first summary block', '第二段🙂']))
    let repo = repository(new FileSessionBackend(options))
    try {
      const handle = await repo.create()
      const sessionId = handle.header.sessionId
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const { runner, source, input } = await prepareSummary(handle, context, provider)
      const settlement = await runner.invoke(input.request, { inputPrecondition: input.inputPrecondition })
      const adopted = await context.adoptModelCompaction(settlement.payload.invocationId, [])
      if (adopted.kind !== 'committed') throw new Error('expected adopted multi-block summary')
      expect(adopted.committed.payload.summary).toBe('first summary block\n\n第二段🙂')
      expect(adopted.committed.payload.algorithm).toMatchObject({ blockIndices: [0, 1] })
      expect(adopted.committed.payload.leaves.map(leaf => leaf.reference)).toEqual([
        { eventId: source.stored.eventId, selector: 'user-input' },
      ])
      const generationProfile = await context.recordProfile(profile())
      const nextInput = await context.recordInput({
        kind: 'user', origin: 'host-authored', originLabel: 'summary fixture', text: 'next task',
      })
      const assembled = await context.assemble(selection(generationProfile.stored.eventId, provider.descriptor, {
        requiredInputs: [{ eventId: nextInput.stored.eventId, selector: 'user-input' }],
        compactions: [adopted.committed.stored.eventId],
      }))
      if (assembled.kind !== 'ready') throw new Error('expected summary-backed generation input')
      expect(assembled.request.messages).toHaveLength(2)
      expect(assembled.request.messages[0]!.content[0]).toMatchObject({ kind: 'text' })
      expect(assembled.request.messages[0]!.content[0]!.kind === 'text' && assembled.request.messages[0]!.content[0]!.text)
        .toContain('first summary block\\n\\n第二段🙂')
      expect(assembled.committed.payload.omitted).toEqual([
        { reference: { eventId: source.stored.eventId, selector: 'user-input' }, reason: 'compacted' },
        { reference: { eventId: nextInput.stored.eventId, selector: 'user-input' }, reason: 'required-duplicate' },
      ])
      const assemblyId = assembled.committed.stored.eventId
      const compactionId = adopted.committed.stored.eventId
      const expectedRequest = assembled.request
      await runner.dispose()
      await context.dispose()
      await provider.dispose()
      await handle.dispose()
      await repo.dispose()

      repo = repository(new FileSessionBackend(options))
      const reopened = await repo.open(sessionId)
      expect(projectContextSession(reopened.snapshot()).compactions[0]!.stored.eventId).toBe(compactionId)
      expect(rebuildAssembly(reopened.snapshot(), input.committed.stored.eventId)).toMatchObject({
        kind: 'rebuilt', request: input.request, adoption: { kind: 'adopted', invocationId: settlement.payload.invocationId },
      })
      expect(rebuildAssembly(reopened.snapshot(), assemblyId)).toMatchObject({
        kind: 'rebuilt', request: expectedRequest, adoption: { kind: 'not-yet-adopted' },
      })
    } finally {
      await provider.dispose()
      await repo.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import type { ModelFrame, ModelOutputBlock, ModelProviderDescriptor, NormalizedModelResult } from '../../src/model/contract.js'
import { ModelResponseAccumulator } from '../../src/model/response.js'
import { scriptedModelDescriptor } from '../../src/model/providers/scripted.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { projectModelSession } from '../../src/model/projection.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { repository, request, runnerLimits, scripted, streamLimits } from './fixtures.js'

const binding = scriptedModelDescriptor({ providerId: 'result-budget', maxConcurrentExchanges: 1, streamLimits })
const start: ModelFrame = { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'result-response' }
const textBlock = (index: number, text: string, complete = false): ModelOutputBlock => ({ kind: 'text', index, text, complete })
function result(blocks: readonly ModelOutputBlock[], fields: Partial<NormalizedModelResult> = {}): NormalizedModelResult {
  return { blocks, usage: { source: 'provider', completeness: 'unknown' }, protocolComplete: false,
    stopReason: null, reportedModel: 'fixture-model', responseId: 'result-response', ...fields }
}
const bytes = (value: NormalizedModelResult): number => Buffer.byteLength(JSON.stringify(value))
function accumulator(maxBytes: number, descriptor: ModelProviderDescriptor = binding): ModelResponseAccumulator {
  const value = new ModelResponseAccumulator(request(), descriptor, { ...runnerLimits, maxNormalizedResultBytes: maxBytes })
  value.accept(start)
  return value
}
function textStart(value: ModelResponseAccumulator, index = 0): void {
  value.accept({ kind: 'block-start', block: 'text', index })
}

it('accepts exact escaped UTF-8 text bytes and keeps the previous frozen result after a one-byte overflow', () => {
  const pieces = ['科研"', '\\\n\t\0', '\ud83d', '', '\udc69‍💻é\u2028']
  const expected = result([textBlock(0, pieces.join(''))]), value = accumulator(bytes(expected))
  textStart(value)
  for (const text of pieces) value.accept({ kind: 'text-delta', index: 0, text })
  const accepted = value.snapshot()
  expect(accepted).toEqual(expected)
  expect(Object.isFrozen(accepted)).toBe(true)
  expect(Object.isFrozen(accepted.blocks[0])).toBe(true)
  expect(() => value.accept({ kind: 'text-delta', index: 0, text: 'x' })).toThrowError(expect.objectContaining({ code: 'MODEL_LIMIT_EXCEEDED' }))
  expect(value.snapshot()).toEqual(accepted)
  value.accept({ kind: 'text-delta', index: 0, text: '' })
  expect(value.snapshot()).toEqual(accepted)
})

it('lets a split surrogate join reduce encoded bytes while retaining its earlier partial snapshot', () => {
  const partial = result([textBlock(0, '\ud83d')]), value = accumulator(bytes(partial))
  textStart(value)
  value.accept({ kind: 'text-delta', index: 0, text: '\ud83d' })
  const retained = value.snapshot()
  value.accept({ kind: 'text-delta', index: 0, text: '' })
  value.accept({ kind: 'text-delta', index: 0, text: '\udc69' })
  expect(value.snapshot()).toEqual(result([textBlock(0, '👩')]))
  value.accept({ kind: 'text-delta', index: 0, text: 'ab' })
  expect(bytes(value.snapshot())).toBe(bytes(partial))
  expect(() => value.accept({ kind: 'text-delta', index: 0, text: 'c' })).toThrowError(expect.objectContaining({ code: 'MODEL_LIMIT_EXCEEDED' }))
  expect(retained).toEqual(partial)
  expect(value.snapshot()).toEqual(result([textBlock(0, '👩ab')]))
})

it.each([
  ['unpaired high and low', ['\ud83d', 'a', '\udc69']],
  ['low before high', ['\udc69', '\ud83d', '']],
  ['paired followed by unpaired', ['\ud83d', '\udc69', '\ud83d']],
] as const)('counts literal surrogates exactly: %s', (_label, pieces) => {
  const expected = result([textBlock(0, pieces.join(''))]), value = accumulator(bytes(expected))
  textStart(value)
  for (const text of pieces) value.accept({ kind: 'text-delta', index: 0, text })
  expect(value.snapshot()).toEqual(expected)
  expect(() => value.accept({ kind: 'text-delta', index: 0, text: 'x' })).toThrowError(expect.objectContaining({ code: 'MODEL_LIMIT_EXCEEDED' }))
})

it('joins text only within its addressed block while interleaving deltas', () => {
  const separate = result([textBlock(0, '\ud83d'), textBlock(1, '\udc69')]), value = accumulator(bytes(separate))
  textStart(value); textStart(value, 1)
  value.accept({ kind: 'text-delta', index: 0, text: '\ud83d' })
  value.accept({ kind: 'text-delta', index: 1, text: '\udc69' })
  expect(value.snapshot()).toEqual(separate)
  expect(() => value.accept({ kind: 'text-delta', index: 0, text: 'x' })).toThrowError(expect.objectContaining({ code: 'MODEL_LIMIT_EXCEEDED' }))
  value.accept({ kind: 'text-delta', index: 0, text: '\udc69' })
  value.accept({ kind: 'text-delta', index: 1, text: 'ab' })
  expect(value.snapshot()).toEqual(result([textBlock(0, '👩'), textBlock(1, '\udc69ab')]))
  expect(bytes(value.snapshot())).toBe(bytes(separate))
})

it('preserves Tool arguments, continuation, closure and usage through the exact final result budget', () => {
  const descriptor = { ...binding, support: { ...binding.support, continuations: ['deepseek.reasoning@1'] } }
  const capsule = { namespace: 'deepseek.reasoning', version: 1, providerId: binding.providerId, model: request().model, text: '推理👩' }
  const expected = result([
    { kind: 'continuation', index: 0, capsule, complete: true },
    { kind: 'tool-call', index: 1, callId: 'call-1', name: 'lookup', argumentsText: '{"query":"👩"}',
      argumentsStatus: 'valid-json', advertisement: 'not-advertised', complete: true },
  ], { usage: { source: 'provider', completeness: 'complete', inputTokens: 0, outputTokens: 4 },
    stopReason: 'tool-calls', protocolComplete: true })
  const value = accumulator(bytes(expected), descriptor)
  value.accept({ kind: 'block-start', index: 0, block: 'continuation', namespace: capsule.namespace,
    version: 1, providerId: capsule.providerId, model: capsule.model })
  value.accept({ kind: 'block-start', index: 1, block: 'tool-call', callId: 'call-1', name: 'lookup' })
  value.accept({ kind: 'continuation-delta', index: 0, text: '推理\ud83d' })
  value.accept({ kind: 'arguments-delta', index: 1, text: '{"query":"\ud83d' })
  value.accept({ kind: 'continuation-delta', index: 0, text: '\udc69' })
  value.accept({ kind: 'arguments-delta', index: 1, text: '\udc69"}' })
  value.accept({ kind: 'block-end', index: 0 }); value.accept({ kind: 'block-end', index: 1 })
  value.accept({ kind: 'usage', counts: { inputTokens: 0, outputTokens: 4 } })
  value.accept({ kind: 'generation-stop', stopReason: 'tool-calls' })
  value.accept({ kind: 'complete', stopReason: 'tool-calls' })
  value.requireComplete()
  expect(value.snapshot()).toEqual(expected)
  expect(Object.isFrozen(value.snapshot().blocks[0])).toBe(true)
})

it('checks the changed Tool arguments status at block closure before publishing it', () => {
  const expected = result([{ kind: 'tool-call', index: 0, callId: 'call-1', name: 'lookup', argumentsText: '{}',
    argumentsStatus: 'partial', advertisement: 'not-advertised', complete: false }])
  const value = accumulator(bytes(expected))
  value.accept({ kind: 'block-start', index: 0, block: 'tool-call', callId: 'call-1', name: 'lookup' })
  value.accept({ kind: 'arguments-delta', index: 0, text: '{}' })
  expect(() => value.accept({ kind: 'block-end', index: 0 })).toThrowError(expect.objectContaining({ code: 'MODEL_LIMIT_EXCEEDED' }))
  expect(value.snapshot()).toEqual(expected)
})

it('keeps the old result when cumulative usage fields exceed the exact ceiling', () => {
  const before = result([textBlock(0, 'answer', true)])
  const after = { ...before, usage: { source: 'provider' as const, completeness: 'partial' as const, inputTokens: 0, outputTokens: 4 } }
  const value = accumulator(bytes(after) - 1)
  textStart(value); value.accept({ kind: 'text-delta', index: 0, text: 'answer' }); value.accept({ kind: 'block-end', index: 0 })
  expect(() => value.accept({ kind: 'usage', counts: { inputTokens: 0, outputTokens: 4 } })).toThrowError(expect.objectContaining({ code: 'MODEL_LIMIT_EXCEEDED' }))
  expect(value.snapshot()).toEqual(before)
})

it('budgets generation-stop and complete against their actual metadata independently', () => {
  const before = result([]), value = accumulator(bytes(before) + 1)
  expect(() => value.accept({ kind: 'generation-stop', stopReason: 'stop' })).toThrowError(expect.objectContaining({ code: 'MODEL_LIMIT_EXCEEDED' }))
  expect(value.snapshot()).toEqual(before)
  value.accept({ kind: 'complete', stopReason: 'stop' })
  expect(value.snapshot()).toEqual(result([], { stopReason: 'stop', protocolComplete: true }))
  expect(bytes(value.snapshot())).toBe(bytes(before) + 1)
})

it('persists fragmented UTF-8 output and replays the same result through an independent File reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-response-budget-'))
  const expected = result([textBlock(0, '科研"\\\n👩', true)], {
    usage: { source: 'provider', completeness: 'complete', inputTokens: 0, outputTokens: 4 }, stopReason: 'stop', protocolComplete: true,
  })
  const repo = repository(new FileSessionBackend({ root, maxRecordBytes: 65536 }))
  const provider = scripted({ script: async function* () {
    yield start; yield { kind: 'block-start', index: 0, block: 'text' }
    for (const text of ['科研"\\\n', '\ud83d', '\udc69']) yield { kind: 'text-delta', index: 0, text }
    yield { kind: 'block-end', index: 0 }; yield { kind: 'usage', counts: { inputTokens: 0, outputTokens: 4 } }
    yield { kind: 'complete', stopReason: 'stop' }
  } })
  const session = await repo.create(), runner = new SessionModelRunner({ session, provider,
    limits: { ...runnerLimits, maxNormalizedResultBytes: bytes(expected) } })
  try {
    const committed = await runner.invoke(request())
    expect(committed.payload.outcome).toBe('completed')
    expect(committed.payload.result).toEqual(expected)
    expect(session.snapshot().localPosition).toBe(3)
    await runner.dispose(); await provider.dispose(); await repo.dispose()
    const reader = repository(new FileSessionBackend({ root, maxRecordBytes: 65536 }))
    try {
      const projected = projectModelSession(await reader.read(session.header.sessionId)).invocations[0]
      expect(projected?.state).toBe('settled')
      if (projected?.state === 'settled') expect(projected.settled.payload.result).toEqual(expected)
    } finally { await reader.dispose() }
  } finally {
    await runner.dispose(); await provider.dispose(); await repo.dispose()
    expect(dirname(root)).toBe(tmpdir())
    await rm(root, { recursive: true, force: true })
  }
})

import {
  MemorySessionBackend,
  ScriptedModelProvider,
  SessionRepository,
  contextSessionEventDefinitions,
  createDurableEventCatalog,
  createMessageCatalog,
  modelSessionEventDefinitions,
  parseSessionId,
} from '../../src/index.js'
import type {
  ContextProfile,
  ContextSelectionSpec,
  DurableEventDefinition,
  MessageCatalog,
  ModelFrame,
  ModelProviderDescriptor,
  ModelRunnerLimits,
  SessionBackend,
  SessionIdentitySource,
} from '../../src/index.js'

const ids = [
  '30000000-0000-4000-8000-000000000101',
  '30000000-0000-4000-8000-000000000102',
  '30000000-0000-4000-8000-000000000103',
] as const

export const runnerLimits: ModelRunnerLimits = Object.freeze({
  maxInputBytes: 1024 * 1024,
  maxNormalizedResultBytes: 64 * 1024,
  maxOutputBlocks: 32,
  maxToolCalls: 8,
  maxJournalConflicts: 4,
})

export const emptyMessageCatalog: MessageCatalog = createMessageCatalog()

export function identities(values: readonly string[] = ids): SessionIdentitySource {
  let index = 0
  return {
    nextSessionId: () => {
      const value = values[index++]
      if (value === undefined) throw new Error('Session identity fixture exhausted')
      return parseSessionId(value)
    },
  }
}

export function repository(
  backend: SessionBackend = new MemorySessionBackend({ maxRecordBytes: 2 * 1024 * 1024 }),
  extraDefinitions: readonly DurableEventDefinition[] = [],
): SessionRepository {
  return new SessionRepository({
    backend,
    catalog: createDurableEventCatalog([
      ...contextSessionEventDefinitions,
      ...modelSessionEventDefinitions,
      ...extraDefinitions,
    ]),
    maxLineageDepth: 8,
    identitySource: identities(),
    clock: { now: () => 1_789_257_600_000 },
  })
}

export function profile(
  purpose: ContextProfile['purpose'] = 'generation',
  overrides: Partial<ContextProfile> = {},
): ContextProfile {
  return {
    profileKey: purpose,
    purpose,
    previousEventId: null,
    sections: purpose === 'compaction'
      ? [{ name: 'summarize', slot: 'task', ordinal: 0, text: 'Summarize the supplied data.', originLabel: 'test' }]
      : [{ name: 'rules', slot: 'rules', ordinal: 0, text: 'Answer precisely.', originLabel: 'test' }],
    toolNames: [],
    rendererVersion: 'context-neutral/v1',
    historyScope: 'local-only',
    tokenAccounting: {
      mode: 'estimate-accepted',
      algorithm: 'neutral-json-utf8-estimate/v1',
      bytesPerEstimatedToken: 4,
      fixedOverheadEstimate: 8,
    },
    budget: {
      contextWindowTokens: 262_144,
      outputReserveTokens: 4096,
      safetyMarginTokens: 256,
      maxRequestBytes: 1024 * 1024,
      maxAssemblyBytes: 1536 * 1024,
      maxSourceEvents: 10_000,
      maxSourceBytes: 64 * 1024 * 1024,
      maxUnits: 10_000,
      maxProvenanceEntries: 20_000,
      maxMemoryCandidates: 1000,
      maxMemoryEstimatedTokens: 64_000,
      maxJsonDepth: 64,
      maxJsonNodes: 250_000,
      minSavingsBytes: 1,
    },
    ...overrides,
  }
}

export function selection(
  profileEventId: ContextSelectionSpec['profileEventId'],
  provider: ModelProviderDescriptor,
  overrides: Partial<ContextSelectionSpec> = {},
): ContextSelectionSpec {
  return {
    profileEventId,
    target: { model: 'fixture-model', maxOutputTokens: 256, provider },
    requiredInputs: [],
    observations: [],
    history: { mode: 'local-suffix', representation: 'raw' },
    compactions: [],
    memory: { required: [], query: { requiredTags: [], queryTags: [], topK: 0 } },
    inbox: [],
    outboxPayloads: [],
    compactionSource: null,
    ...overrides,
  }
}

async function* textFrames(text: string): AsyncGenerator<ModelFrame> {
  yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'context-response' }
  yield { kind: 'block-start', index: 0, block: 'text' }
  yield { kind: 'text-delta', index: 0, text }
  yield { kind: 'block-end', index: 0 }
  yield { kind: 'usage', counts: { inputTokens: 10, outputTokens: 3 } }
  yield { kind: 'complete', stopReason: 'stop' }
}

export function scriptedModel(text = 'model answer', counters?: { prepare: number; acquire: number; start: number }) {
  return new ScriptedModelProvider({
    providerId: 'context-scripted',
    maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16_384, maxStreamBytes: 262_144, maxFrames: 1000 },
    onPrepare: () => { if (counters !== undefined) counters.prepare += 1 },
    onAcquire: () => { if (counters !== undefined) counters.acquire += 1 },
    script: () => {
      if (counters !== undefined) counters.start += 1
      return textFrames(text)
    },
  })
}

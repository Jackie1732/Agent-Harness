import * as h from '../dist/index.js'

export const modelLimits = {
  maxInputBytes: 1024 * 1024, maxNormalizedResultBytes: 64 * 1024,
  maxOutputBlocks: 32, maxToolCalls: 8, maxJournalConflicts: 4,
}

export function contextProfile(purpose = 'generation', overrides = {}) {
  return {
    profileKey: purpose, purpose, previousEventId: null,
    sections: purpose === 'compaction'
      ? [{ name: 'summarize', slot: 'task', ordinal: 0, text: 'Summarize the supplied data.', originLabel: 'example' }]
      : [{ name: 'rules', slot: 'rules', ordinal: 0, text: 'Answer precisely.', originLabel: 'example' }],
    toolNames: [], rendererVersion: 'context-neutral/v1', historyScope: 'local-only',
    tokenAccounting: { mode: 'estimate-accepted', algorithm: 'neutral-json-utf8-estimate/v1', bytesPerEstimatedToken: 4, fixedOverheadEstimate: 8 },
    budget: {
      contextWindowTokens: 262_144, outputReserveTokens: 4096, safetyMarginTokens: 256,
      maxRequestBytes: 1024 * 1024, maxAssemblyBytes: 1536 * 1024,
      maxSourceEvents: 10_000, maxSourceBytes: 64 * 1024 * 1024, maxUnits: 10_000,
      maxProvenanceEntries: 20_000, maxMemoryCandidates: 1000, maxMemoryEstimatedTokens: 64_000,
      maxJsonDepth: 64, maxJsonNodes: 250_000, minSavingsBytes: 1,
    },
    ...overrides,
  }
}

export function contextSelection(profileEventId, provider, overrides = {}) {
  return {
    profileEventId,
    target: { model: 'fixture-model', maxOutputTokens: 256, provider },
    requiredInputs: [], observations: [],
    history: { mode: 'local-suffix', representation: 'raw' }, compactions: [],
    memory: { required: [], query: { requiredTags: [], queryTags: [], topK: 0 } },
    inbox: [], outboxPayloads: [], compactionSource: null,
    ...overrides,
  }
}

export function sessionRepository(backend) {
  return new h.SessionRepository({
    backend,
    catalog: h.createDurableEventCatalog([
      ...h.contextSessionEventDefinitions,
      ...h.communicationSessionEventDefinitions,
      ...h.modelSessionEventDefinitions,
      ...h.toolSessionEventDefinitions,
    ]),
    maxLineageDepth: 8,
  })
}

export function scriptedTextProvider(text = 'example response') {
  return new h.ScriptedModelProvider({
    providerId: 'context-example', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16_384, maxStreamBytes: 262_144, maxFrames: 1000 },
    script: async function* () {
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'example-response' }
      yield { kind: 'block-start', index: 0, block: 'text' }
      yield { kind: 'text-delta', index: 0, text }
      yield { kind: 'block-end', index: 0 }
      yield { kind: 'complete', stopReason: 'stop' }
    },
  })
}

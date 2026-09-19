import type { JsonObject } from '../../src/index.js'

export const hostSessionId = '70000000-0000-4000-8000-000000000101'

export function hostConfig(root: string): JsonObject {
  return {
    schemaVersion: 1,
    hostKey: 'test-host',
    storage: { root, maxRecordBytes: 1024 * 1024, maxLineageDepth: 4 },
    members: [{
      kind: 'local', agentKey: 'writer', sessionId: hostSessionId, mode: 'create', enabled: true,
      profile: {
        profileKey: 'writer-generation', purpose: 'generation', previousEventId: null,
        sections: [{ name: 'rules', slot: 'rules', ordinal: 0, text: 'Answer the task.', originLabel: 'test-config' }],
        toolNames: [], rendererVersion: 'context-neutral/v2', historyScope: 'local-only',
        tokenAccounting: { mode: 'estimate-accepted', algorithm: 'neutral-json-utf8-estimate/v1', bytesPerEstimatedToken: 4, fixedOverheadEstimate: 8 },
        budget: { contextWindowTokens: 8192, outputReserveTokens: 256, safetyMarginTokens: 32,
          maxRequestBytes: 262144, maxAssemblyBytes: 524288, maxSourceEvents: 1000, maxSourceBytes: 1048576,
          maxUnits: 1000, maxProvenanceEntries: 2000, maxMemoryCandidates: 0, maxMemoryEstimatedTokens: 0,
          maxJsonDepth: 32, maxJsonNodes: 10000, minSavingsBytes: 0 },
      },
      spec: {
        protocolVersion: 1, label: 'Writer', responsibility: 'Answer submitted tasks.', nonGoals: [],
        target: { model: 'fixed-model', maxOutputTokens: 256 }, toolNames: [], nativeActions: [], peers: [], messages: [],
        context: { history: { mode: 'none', maxRoots: 0 }, memory: { required: [], query: { requiredTags: [], queryTags: [], topK: 0 } }, compactions: [] },
        budget: { models: 8, steps: 8, tools: 0, messages: 0, waits: 2, outputTokens: 2048 },
        rootDurationMs: 60000, maxDirectSendCommandsPerSession: 2,
        limits: { maxTurnsPerRun: 4, maxManagementPerRun: 16, maxDispatchRunsPerRun: 1, maxJournalConflicts: 4,
          maxReassemblies: 2, maxPendingInputs: 16, maxPendingWaits: 4, maxLanes: 8, maxInputBytes: 4096,
          maxActionsPerStep: 4, maxActionBytes: 4096, maxResultBytes: 16384, maxReportEntries: 100, maxWaitMs: 60000 },
        errorFeedback: 'new-step', usagePolicy: 'observe-only', businessRefusalHandled: false,
      },
      model: {
        kind: 'scripted-fixed', providerId: 'fixed-provider', text: 'fixed answer', maxConcurrentExchanges: 1,
        streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
        runnerLimits: { maxInputBytes: 1048576, maxNormalizedResultBytes: 65536, maxOutputBlocks: 32, maxToolCalls: 0, maxJournalConflicts: 4 },
      },
      tools: { kind: 'none' },
    }],
    messages: [], channels: [],
    routes: [{ memberKey: 'writer', ownerHost: 'test-host', origin: null, serverName: null }],
    https: { kind: 'disabled' },
    communication: { maxMessageBytes: 4096, maxPendingOutbox: 16, maxPendingInbox: 16,
      maxDeliveryAttempts: 3, maxAttemptsPerRun: 3, maxSendJournalConflicts: 4 },
    scheduling: { scanIntervalMs: 10, maxSlotsPerScan: 1, maxBatchesPerRun: 8,
      maxNoProgressBatches: 2, retryIntervalMs: 100, maxReportEntries: 100 },
    cli: { maxLineBytes: 65536, maxQueuedCommands: 8, maxPendingControls: 8,
      maxOutputBytes: 1048576, outputDrainTimeoutMs: 1000 },
  }
}

export function twoMemberHostConfig(root: string): JsonObject {
  const base = hostConfig(root)
  const first = (base.members as readonly JsonObject[])[0]!
  const firstSpec = first.spec as JsonObject
  const firstProfile = first.profile as JsonObject
  const firstModel = first.model as JsonObject
  const secondSessionId = '70000000-0000-4000-8000-000000000102'
  const channelId = '71000000-0000-4000-8000-000000000101'
  const message = { type: 'test/note', payloadVersion: 1, requiresReply: false }
  const member = (agentKey: string, sessionId: string, peerKey: string, peerMemberKey: string, providerId: string): JsonObject => ({
    ...first, agentKey, sessionId,
    profile: { ...firstProfile, profileKey: `${agentKey}-generation` },
    spec: { ...firstSpec, label: agentKey, nativeActions: ['agent_send_message'],
      peers: [{ key: peerKey, memberKey: peerMemberKey, channelKey: 'shared' }], messages: [message] },
    model: { ...firstModel, providerId, text: `${agentKey} answer` },
  })
  return {
    ...base,
    members: [member('writer', hostSessionId, 'reviewer', 'reviewer', 'writer-provider'),
      member('reviewer', secondSessionId, 'writer', 'writer', 'reviewer-provider')],
    messages: [{ type: 'test/note', payloadVersion: 1, schema: { type: 'object', properties: {
      text: { type: 'string' },
    }, required: ['text'], additionalProperties: false } }],
    channels: [{ channelKey: 'shared', channelId }],
    routes: [
      { memberKey: 'writer', ownerHost: 'test-host', origin: null, serverName: null },
      { memberKey: 'reviewer', ownerHost: 'test-host', origin: null, serverName: null },
    ],
  }
}

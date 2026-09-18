/** Explicit offline demo configuration; production hosts supply their own limits and bindings. */
export function agentSpec(profileEventId, provider, overrides = {}) {
  return {
    protocolVersion: 1, label: 'research-agent', responsibility: 'Complete one bounded research task.', nonGoals: [], profileEventId,
    target: { model: 'fixture-model', maxOutputTokens: 256, provider }, toolNames: [], nativeActions: [], peers: [], messages: [],
    context: { history: { mode: 'none', maxRoots: 0 }, memory: { required: [], query: { requiredTags: [], queryTags: [], topK: 0 } }, compactions: [] },
    budget: { models: 8, steps: 8, tools: 8, messages: 8, waits: 4, outputTokens: 4096 }, rootDurationMs: 60_000, maxDirectSendCommandsPerSession: 8,
    limits: { maxTurnsPerRun: 8, maxManagementPerRun: 32, maxDispatchRunsPerRun: 2, maxJournalConflicts: 4, maxReassemblies: 2,
      maxPendingInputs: 32, maxPendingWaits: 8, maxLanes: 16, maxInputBytes: 4096, maxActionsPerStep: 8,
      maxActionBytes: 4096, maxResultBytes: 16384, maxReportEntries: 100, maxWaitMs: 30000 },
    errorFeedback: 'new-step', usagePolicy: 'observe-only', businessRefusalHandled: false, ...overrides,
  }
}

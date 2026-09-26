import { DEFAULT_WORKFLOW_LIMITS } from '../../src/workflow/definition.js'

const grant = { models: 2, steps: 2, tools: 0, messages: 2, waits: 1, outputTokens: 128 }
const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
const attempt = { workerGrant: grant, reviewerGrants: [], durationMs: 60_000, retryDecisionMs: 60_000,
  toolNames: [], nativeActions: [], workspace: { kind: 'none' } }

/** Two independent peers and one accepted-output dependency. */
export function workflowFixture() {
  return {
    version: 1, workflowKey: 'research', coordinator: 'ah-session:87000000-0000-4000-8000-000000000001',
    roster: [
      { memberKey: 'reader', address: 'ah-session:87000000-0000-4000-8000-000000000002', roles: ['reader'],
        canProduce: true, canReview: false, specFingerprint: 'a'.repeat(64), contextFingerprint: 'c'.repeat(64),
        budgetCeiling: grant, resourceIds: [] },
      { memberKey: 'writer', address: 'ah-session:87000000-0000-4000-8000-000000000003', roles: ['writer'],
        canProduce: true, canReview: false, specFingerprint: 'b'.repeat(64), contextFingerprint: 'd'.repeat(64),
        budgetCeiling: grant, resourceIds: [] },
    ],
    communication: { ask: [{ from: 'reader', to: 'writer' }], groups: [], disclosures: [
      { nodeKey: 'read', recipients: ['coordinator', 'writer'] },
      { nodeKey: 'write', recipients: ['coordinator'] },
    ] },
    nodes: [
      { nodeKey: 'read', executor: 'reader', task: 'Read the assigned passage', dependencies: [], inputs: [],
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        guard: { kind: 'always' }, output: { kind: 'json', schema, artifacts: [] },
        acceptance: { kind: 'schema-only' }, attempts: [attempt] },
      { nodeKey: 'write', executor: 'writer', task: 'Summarize the accepted passage',
        dependencies: [{ nodeKey: 'read', mode: 'required' }],
        inputs: [{ name: 'text', source: { kind: 'accepted', nodeKey: 'read', path: ['text'] } }],
        inputSchema: schema, guard: { kind: 'always' }, output: { kind: 'text', name: 'report' },
        acceptance: { kind: 'schema-only' }, attempts: [attempt] },
    ], requiredOutputs: ['write'], deadline: '2030-01-01T00:00:00.000Z',
    budget: { models: 8, steps: 8, tools: 0, messages: 8, waits: 4, outputTokens: 512 },
    limits: { ...DEFAULT_WORKFLOW_LIMITS }, failurePolicy: 'fail-fast',
  }
}

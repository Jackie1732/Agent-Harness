import { randomUUID } from 'node:crypto'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { decodeHostConfig } from '../host/config.js'
import { decodeApiConfig } from '../api/config.js'
import { decodeUiConfig } from '../ui/config.js'
import { decodeAutomationConfig } from '../automation/config.js'
import { decodeExperimentDefinition } from '../experiment/definition.js'
import { CONTROL_METHODS } from '../protocol/index.js'
import { HostError } from '../host/errors.js'
import type { ConfigKind } from './config-types.js'

/** Required deployment choices for the terminal's common Host templates. */
export interface HostPresetParams {
  readonly hostKey: string
  readonly storageRoot: string
  readonly agentKey?: string
  readonly text?: string
  readonly http?: { readonly kind: 'deepseek' | 'anthropic'; readonly endpoint: string; readonly credentialRef: string; readonly model: string }
}
/** Build complete v3 deployment templates with draft Host identities. */
export function buildHostPreset(preset: 'solo-scripted' | 'solo-http' | 'collaboration', params: HostPresetParams, baseDirectory = process.cwd()): JsonValue {
  if (preset === 'solo-http' && params.http === undefined) throw new HostError('HOST_CONFIG_INVALID', 'host-preset-http-fields-required')
  const agentKeys = preset === 'collaboration' ? [params.agentKey ?? 'writer', 'reviewer'] : [params.agentKey ?? 'writer']
  const members = agentKeys.map((agentKey, index) => ({
    kind: 'local', agentKey, sessionId: null, mode: 'create', enabled: true,
    profile: { profileKey: `${agentKey}-generation`, purpose: 'generation', previousEventId: null,
      sections: [{ name: 'rules', slot: 'rules', ordinal: 0, text: 'Complete the submitted task. Ask the user when clarification is required.', originLabel: 'operator-setup' }],
      toolNames: [], rendererVersion: 'context-neutral/v2', historyScope: 'local-only',
      tokenAccounting: { mode: 'estimate-accepted', algorithm: 'neutral-json-utf8-estimate/v1', bytesPerEstimatedToken: 4, fixedOverheadEstimate: 8 },
      budget: { contextWindowTokens: 8192, outputReserveTokens: 512, safetyMarginTokens: 32,
        maxRequestBytes: 262144, maxAssemblyBytes: 524288, maxSourceEvents: 1000, maxSourceBytes: 1048576,
        maxUnits: 1000, maxProvenanceEntries: 2000, maxMemoryCandidates: 0, maxMemoryEstimatedTokens: 0, maxJsonDepth: 32, maxJsonNodes: 10000, minSavingsBytes: 0 } },
    spec: { protocolVersion: 1, label: agentKey, responsibility: 'Complete submitted tasks.', nonGoals: [],
      target: { model: preset === 'solo-http' ? params.http!.model : 'fixed-model', maxOutputTokens: 512 }, toolNames: [],
      nativeActions: ['agent_ask_user', ...(preset === 'collaboration' ? ['agent_send_message'] : [])],
      peers: preset === 'collaboration' ? [{ key: agentKeys[1 - index]!, memberKey: agentKeys[1 - index]!, channelKey: 'shared' }] : [],
      messages: preset === 'collaboration' ? [{ type: 'operator/note', payloadVersion: 1, requiresReply: false }] : [],
      context: { history: { mode: 'completed-roots', maxRoots: 8 }, memory: { required: [], query: { requiredTags: [], queryTags: [], topK: 0 } }, compactions: [] },
      budget: { models: 16, steps: 16, tools: 0, messages: 16, waits: 8, outputTokens: 8192 }, rootDurationMs: 300000, maxDirectSendCommandsPerSession: 64,
      limits: { maxTurnsPerRun: 4, maxManagementPerRun: 16, maxDispatchRunsPerRun: 1, maxJournalConflicts: 4, maxReassemblies: 2,
        maxPendingInputs: 64, maxPendingWaits: 8, maxLanes: 16, maxInputBytes: 65536, maxActionsPerStep: 8, maxActionBytes: 65536,
        maxResultBytes: 131072, maxReportEntries: 100, maxWaitMs: 300000 }, errorFeedback: 'new-step', usagePolicy: 'observe-only', businessRefusalHandled: false },
    model: { ...(preset === 'solo-http' ? { kind: params.http!.kind, providerId: `${agentKey}-provider`, endpoint: params.http!.endpoint, credentialRef: params.http!.credentialRef }
      : { kind: 'scripted-fixed', providerId: `${agentKey}-provider`, text: params.text ?? 'Offline scripted response.' }), maxConcurrentExchanges: 1,
      streamLimits: { maxFrameBytes: 65536, maxStreamBytes: 1048576, maxFrames: 10000 },
      runnerLimits: { maxInputBytes: 1048576, maxNormalizedResultBytes: 262144, maxOutputBlocks: 64, maxToolCalls: 8, maxJournalConflicts: 4 } },
    tools: { kind: 'none' }, workflowTools: { kind: 'none' },
  }))
  return decodeHostConfig({ schemaVersion: 3, hostKey: params.hostKey, storage: { root: params.storageRoot, maxRecordBytes: 8 * 1024 * 1024, maxLineageDepth: 4 },
    members, messages: preset === 'collaboration' ? [{ type: 'operator/note', payloadVersion: 1,
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] : [],
    channels: preset === 'collaboration' ? [{ channelKey: 'shared', channelId: null }] : [],
    routes: agentKeys.map(memberKey => ({ memberKey, ownerHost: params.hostKey, origin: null, serverName: null })), https: { kind: 'disabled' },
    communication: { maxMessageBytes: 65536, maxPendingOutbox: 64, maxPendingInbox: 64, maxDeliveryAttempts: 3, maxAttemptsPerRun: 3, maxSendJournalConflicts: 4 },
    scheduling: { scanIntervalMs: 250, maxSlotsPerScan: 4, maxBatchesPerRun: 16, maxNoProgressBatches: 2, retryIntervalMs: 1000, maxReportEntries: 100 },
    cli: { maxLineBytes: 1048576, maxQueuedCommands: 64, maxPendingControls: 8, maxOutputBytes: 4194304, outputDrainTimeoutMs: 5000 },
    shutdown: { mode: 'cancel', diagnosticAfterMs: 5000 }, subagents: { kind: 'disabled' }, workspaceResources: [], workflows: { kind: 'disabled' } }, baseDirectory) as unknown as JsonValue
}
const clientLimits = { maxRequestBytes: 1048576, maxResponseBytes: 2097152, maxJsonDepth: 64, maxJsonNodes: 100000, connectTimeoutMs: 5000, requestTimeoutMs: 60000, maxConnections: 4 }
function required(params: JsonObject, name: string): JsonValue { if (!Object.hasOwn(params, name)) throw new HostError('HOST_CONFIG_INVALID', 'preset-field-required', { field: name }); return params[name]! }
/** Build service templates only after the form supplies certificate and target choices. */
export function buildConfigPreset(kind: Exclude<ConfigKind, 'operator' | 'host'>, preset: string, params: JsonObject, baseDirectory: string): JsonValue {
  if (kind === 'api' && preset === 'mtls') return decodeApiConfig({ schemaVersion: 1, listenHost: params.listenHost ?? '127.0.0.1', listenPort: params.listenPort ?? 8443,
    tls: required(params, 'tls'), principals: [{ principalKey: params.principalKey ?? 'operator', certificateFingerprints: required(params, 'certificateFingerprints'),
      methods: [...CONTROL_METHODS], agentKeys: required(params, 'agentKeys'), workflowKeys: params.workflowKeys ?? [] }],
    limits: { maxRequestBytes: 1048576, maxJsonDepth: 64, maxJsonNodes: 100000, maxHeaderBytes: 8192, maxResponseBytes: 2097152, maxPageEvents: 64,
      maxConnections: 16, maxPendingInputs: 8, maxPendingControls: 8, maxObservers: 4, maxPendingShutdowns: 2,
      requestReadTimeoutMs: 5000, responseWriteTimeoutMs: 5000, tlsHandshakeTimeoutMs: 5000, headersTimeoutMs: 5000, keepAliveTimeoutMs: 1000,
      maxWaitMs: 30000, observerScanIntervalMs: 250 } }) as unknown as JsonValue
  if (kind === 'ui' && preset === 'gateway') {
    const tls = required(params, 'tls') as JsonObject
    return decodeUiConfig({ schemaVersion: 1, listenPort: params.listenPort ?? 8444,
      remote: { origin: required(params, 'origin'), serverName: params.serverName ?? null, caFile: tls.caFile, certFile: tls.certFile, keyFile: tls.keyFile, limits: clientLimits },
      passwordEnv: required(params, 'passwordEnv'), memberKeys: required(params, 'agentKeys'), workflowKeys: params.workflowKeys ?? [],
      limits: { maxRequestBytes: 1048576, maxJsonDepth: 64, maxJsonNodes: 100000, maxHeaderBytes: 8192, maxConnections: 16, maxPendingRequests: 8,
        requestReadTimeoutMs: 5000, responseWriteTimeoutMs: 5000, headersTimeoutMs: 5000, keepAliveTimeoutMs: 1000, sessionTimeoutMs: 3600000 } }) as unknown as JsonValue
  }
  if (kind === 'automation' && (preset === 'webhook' || preset === 'utc')) return decodeAutomationConfig({ schemaVersion: 1,
    automationKey: required(params, 'automationKey'), hostKey: required(params, 'hostKey'), journal: { root: required(params, 'journalRoot'), sessionId: params.journalSessionId ?? randomUUID(),
      maxRecordBytes: 8388608, maxTriggers: 10000, maxEvents: 100000 },
    client: { origin: required(params, 'origin'), serverName: params.serverName ?? null, tls: required(params, 'tls'), limits: clientLimits },
    webhook: { listenHost: params.listenHost ?? '127.0.0.1', listenPort: params.listenPort ?? 8445, tls: required(params, 'webhookTls'), bearerTokenEnv: required(params, 'bearerTokenEnv') },
    limits: { maxRequestBytes: 65536, maxResponseBytes: 2097152, maxJsonDepth: 32, maxJsonNodes: 10000, maxHeaderBytes: 8192,
      maxConnections: 8, maxPendingRequests: 4, maxQueued: 16, requestReadTimeoutMs: 5000, responseWriteTimeoutMs: 5000,
      headersTimeoutMs: 5000, tlsHandshakeTimeoutMs: 5000, keepAliveTimeoutMs: 1000, observeIntervalMs: 1000 },
    jobs: [{ jobKey: required(params, 'jobKey'), agentKey: required(params, 'agentKey'), trigger: preset === 'webhook' ? { kind: 'webhook' }
      : { kind: 'interval', anchor: required(params, 'anchor'), intervalMs: required(params, 'intervalMs'), text: required(params, 'text') } }] }) as unknown as JsonValue
  if (kind === 'experiment' && preset === 'fixture') {
    const host = required(params, 'host'), agentKey = required(params, 'agentKey')
    return decodeExperimentDefinition({ version: 1, experimentKey: required(params, 'experimentKey'),
      dataset: { datasetKey: params.datasetKey ?? 'sample', version: '1', cases: [{ caseKey: 'case', task: required(params, 'text'), materials: [],
        output: { outputKey: 'answer', mediaType: 'text/plain' }, primaryEvaluatorKey: 'exact' }] },
      variants: [{ variantKey: 'scripted', recipe: host, bindings: [{ caseKey: 'case', kind: 'agent', agentKey, inputMode: 'inline', materials: [], output: { kind: 'root-final' } }],
        factors: {}, fixture: { kind: 'builtin' } }], comparisons: [], repetitions: 1, order: 'declared',
      evaluators: [{ evaluatorKey: 'exact', version: '1', implementationVersion: 'rules/v1', rules: [{ ruleKey: 'answer', kind: 'text-exact', normalize: [], expected: required(params, 'expected') }] }],
      runPolicy: { mode: 'fixture', maxDriveCalls: 16, maxWallTimeMs: 60000, onCaseFailure: 'continue' },
      storage: { controlRoot: required(params, 'controlRoot'), workspaceRoot: required(params, 'workspaceRoot'), maxRecordBytes: 8388608 },
      evidenceLimits: { maxCases: 100, maxVariants: 16, maxUnits: 1000, maxInputBytes: 1048576, maxPlanBytes: 8388608, maxRecipeBytes: 2097152,
        maxSessionCount: 10000, maxEvents: 100000, maxEvidenceBytes: 8388608, maxMetricSamples: 100000, maxReportBytes: 8388608, maxFixtureEntries: 1000, maxFixtureBytes: 8388608 }, provenance: {} }, baseDirectory) as unknown as JsonValue
  }
  throw new HostError('HOST_CONFIG_INVALID', 'configuration-preset-invalid')
}

/** Editable form fields name every required deployment choice; budgets belong to the selected template. */
export function configPresetParameters(kind: Exclude<ConfigKind, 'operator' | 'host'>, preset: string, baseDirectory = process.cwd()): JsonObject {
  if (kind === 'api' && preset === 'mtls') return { listenHost: '127.0.0.1', listenPort: 8443,
    tls: { caFile: './tls/ca.pem', serverCertFile: './tls/server.pem', serverKeyFile: './tls/server-key.pem' },
    principalKey: 'operator', certificateFingerprints: [''], agentKeys: ['writer'], workflowKeys: [] }
  if (kind === 'ui' && preset === 'gateway') return { listenPort: 8444, origin: 'https://localhost:8443', serverName: 'localhost',
    tls: { caFile: './tls/ca.pem', certFile: './tls/client.pem', keyFile: './tls/client-key.pem' }, passwordEnv: 'ATOMIC_UI_PASSWORD', agentKeys: ['writer'], workflowKeys: [] }
  if (kind === 'automation' && (preset === 'webhook' || preset === 'utc')) return { automationKey: 'automation', hostKey: 'local-host', journalRoot: './automation-journal',
    journalSessionId: randomUUID(), origin: 'https://localhost:8443', serverName: 'localhost', tls: { caFile: './tls/ca.pem', certFile: './tls/client.pem', keyFile: './tls/client-key.pem' },
    listenHost: '127.0.0.1', listenPort: 8445, webhookTls: { certFile: './tls/webhook.pem', keyFile: './tls/webhook-key.pem' }, bearerTokenEnv: 'ATOMIC_AUTOMATION_TOKEN',
    jobKey: 'job', agentKey: 'writer', ...(preset === 'utc' ? { anchor: new Date().toISOString(), intervalMs: 86400000, text: 'Review the configured materials.' } : {}) }
  if (kind === 'experiment' && preset === 'fixture') return { experimentKey: 'fixture', datasetKey: 'sample',
    host: buildHostPreset('solo-scripted', { hostKey: 'fixture-host', storageRoot: './template', text: '42' }, baseDirectory), agentKey: 'writer',
    text: 'What is the answer?', expected: '42', controlRoot: './experiment-control', workspaceRoot: './experiment-work' }
  throw new HostError('HOST_CONFIG_INVALID', 'configuration-preset-invalid')
}

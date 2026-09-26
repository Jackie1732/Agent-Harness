import { compileInlineValidator } from '../schema/inline-validator.js'
import { decodeAgentBudget } from '../agent/budget.js'
import type { AgentBudget } from '../agent/contract.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { boundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import { InlineSchemaError, validateInlineSchema } from '../schema/inline.js'
import { formatSessionAddress, parseSessionAddress } from '../session/ids.js'
import { SessionError } from '../session/errors.js'
import { workspaceRelativePath } from '../tool/workspace-path.js'
import { ToolError } from '../tool/errors.js'
import { invalidDefinition } from './errors.js'
import { validateWorkflowGraph } from './graph.js'
import type { WorkflowAcceptance, WorkflowAttempt, WorkflowCommunication, WorkflowDefinition, WorkflowDependency, WorkflowGuard,
  WorkflowInput, WorkflowLimits, WorkflowMember, WorkflowNode, WorkflowOutput, WorkflowWorkspace } from './types.js'

/** Deployment ceiling; a recorded definition may choose tighter limits. */
export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = Object.freeze({
  maxNodes: 64, maxEdges: 256, maxMembers: 16, maxAttemptsPerNode: 3, maxReviewersPerNode: 8,
  maxActiveAssignments: 16, maxDefinitions: 16, maxArtifactsPerAttempt: 8,
  maxArtifactBytes: 16 * 1024, maxTotalArtifactBytes: 512 * 1024,
  maxDefinitionBytes: 128 * 1024, maxSchemaDepth: 16, maxSchemaNodes: 2_048,
  maxValueBytes: 32 * 1024, maxTextBytes: 16 * 1024,
  maxProtocolMessages: 4096, maxQuestions: 4, maxIncomingQuestions: 4, maxGroups: 2,
  maxGroupRecipients: 8, maxIncomingGroupMessages: 8, maxProgress: 4,
  maxWaitMs: 60_000, maxCommitConflicts: 4, maxDiscoveryEntries: 4096,
  maxRecoveryWrites: 128, maxReportEntries: 100,
})

const limitFields = Object.keys(DEFAULT_WORKFLOW_LIMITS) as (keyof WorkflowLimits)[]
const zeroLimitFields = new Set<keyof WorkflowLimits>(['maxQuestions', 'maxIncomingQuestions', 'maxGroups',
  'maxGroupRecipients', 'maxIncomingGroupMessages', 'maxProgress', 'maxCommitConflicts', 'maxRecoveryWrites'])
const identifierPattern = /^[A-Za-z][A-Za-z0-9_.-]*$/
const own = Object.hasOwn

function object(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidDefinition(`${label}-object`)
  return value as Record<string, JsonValue>
}
function fields(value: Record<string, JsonValue>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !own(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    invalidDefinition('fields')
  }
}
function list(value: JsonValue | undefined, label: string, maximum: number): readonly JsonValue[] {
  if (!Array.isArray(value) || value.length > maximum) invalidDefinition(`${label}-array`)
  return value
}
function text(value: JsonValue | undefined, label: string, maximum = 128): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximum) invalidDefinition(`${label}-text`)
  return value
}
function key(value: JsonValue | undefined, label: string): string {
  const result = text(value, label)
  if (!identifierPattern.test(result)) invalidDefinition(`${label}-identifier`)
  return result
}
function integer(value: JsonValue | undefined, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalidDefinition(`${label}-integer`)
  return value as number
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalidDefinition(`${label}-duplicate`)
}
function strings(value: JsonValue | undefined, label: string, maximum: number): readonly string[] {
  const result = list(value, label, maximum).map(item => key(item, label))
  unique(result, label)
  return result
}
function path(value: JsonValue | undefined, label: string): readonly string[] {
  const segments = list(value, label, 16).map(item => text(item, label, 256))
  if (!segments.length) invalidDefinition(`${label}-path`)
  return segments
}

function communication(value: JsonValue | undefined, limitsValue: WorkflowLimits): WorkflowCommunication {
  const input = object(value, 'communication')
  fields(input, ['ask', 'groups', 'disclosures'])
  const ask = list(input.ask, 'ask', limitsValue.maxEdges).map(value => {
    const item = object(value, 'ask'); fields(item, ['from', 'to'])
    return { from: key(item.from, 'ask.from'), to: key(item.to, 'ask.to') }
  })
  unique(ask.map(item => `${item.from}\u0000${item.to}`), 'ask')
  const groups = list(input.groups, 'groups', limitsValue.maxMembers).map(value => {
    const item = object(value, 'group'); fields(item, ['from', 'recipients'])
    return { from: key(item.from, 'group.from'), recipients: strings(item.recipients, 'group.recipient', limitsValue.maxMembers) }
  })
  unique(groups.map(item => item.from), 'group.from')
  const disclosures = list(input.disclosures, 'disclosures', limitsValue.maxNodes).map(value => {
    const item = object(value, 'disclosure'); fields(item, ['nodeKey', 'recipients'])
    return { nodeKey: key(item.nodeKey, 'disclosure.nodeKey'),
      recipients: strings(item.recipients, 'disclosure.recipient', limitsValue.maxMembers + 1) }
  })
  unique(disclosures.map(item => item.nodeKey), 'disclosure.nodeKey')
  return { ask, groups, disclosures }
}
function schema(value: JsonValue | undefined, limits: WorkflowLimits): JsonObject {
  const candidate = object(value, 'schema') as JsonObject
  validateInlineSchema(candidate, 0, limits.maxSchemaDepth)
  if (candidate.type !== 'object' || candidate.additionalProperties !== false) invalidDefinition('schema-open-object')
  boundedJson(candidate, { maxBytes: limits.maxDefinitionBytes, maxDepth: limits.maxSchemaDepth + 2, maxNodes: limits.maxSchemaNodes })
  try {
    compileInlineValidator(candidate)
  } catch { invalidDefinition('schema-compilation') }
  return candidate
}
function limits(value: JsonValue | undefined, ceiling: WorkflowLimits): WorkflowLimits {
  const input = object(value, 'limits')
  fields(input, limitFields)
  const result = Object.fromEntries(limitFields.map(field => [field, integer(input[field], field,
    zeroLimitFields.has(field) ? 0 : 1)])) as unknown as WorkflowLimits
  if (limitFields.some(field => result[field] > ceiling[field]) || result.maxSchemaDepth > 32) invalidDefinition('limits-ceiling')
  return result
}
function budget(value: JsonValue | undefined, label: string): AgentBudget {
  try { return decodeAgentBudget(value) } catch { invalidDefinition(`${label}-budget`) }
}
function member(value: JsonValue, maximum: number): WorkflowMember {
  const input = object(value, 'member')
  fields(input, ['memberKey', 'address', 'roles', 'canProduce', 'canReview', 'specFingerprint',
    'contextFingerprint', 'budgetCeiling', 'resourceIds'])
  const address = formatSessionAddress(parseSessionAddress(text(input.address, 'member.address', 64)))
  if (typeof input.canProduce !== 'boolean' || typeof input.canReview !== 'boolean') invalidDefinition('member-permission')
  const fingerprint = text(input.specFingerprint, 'member.fingerprint', 64)
  const contextFingerprint = text(input.contextFingerprint, 'member.contextFingerprint', 64)
  if (!/^[0-9a-f]{64}$/.test(fingerprint) || !/^[0-9a-f]{64}$/.test(contextFingerprint)) invalidDefinition('member-fingerprint')
  return { memberKey: key(input.memberKey, 'memberKey'), address, roles: strings(input.roles, 'role', maximum),
    canProduce: input.canProduce, canReview: input.canReview, specFingerprint: fingerprint,
    contextFingerprint, budgetCeiling: budget(input.budgetCeiling, 'member'),
    resourceIds: strings(input.resourceIds, 'resourceId', maximum) }
}
function dependency(value: JsonValue): WorkflowDependency {
  const input = object(value, 'dependency'); fields(input, ['nodeKey', 'mode'])
  if (input.mode !== 'required' && input.mode !== 'optional') invalidDefinition('dependency-mode')
  return { nodeKey: key(input.nodeKey, 'dependency.nodeKey'), mode: input.mode }
}
function inputSource(value: JsonValue): WorkflowInput['source'] {
  const input = object(value, 'input.source')
  if (input.kind === 'literal') { fields(input, ['kind', 'value']); return { kind: 'literal', value: input.value! } }
  if (input.kind !== 'accepted') invalidDefinition('input-kind')
  fields(input, ['kind', 'nodeKey', 'path'], ['fallback'])
  return { kind: 'accepted', nodeKey: key(input.nodeKey, 'input.nodeKey'), path: path(input.path, 'input.path'),
    ...(own(input, 'fallback') ? { fallback: input.fallback! } : {}) }
}
function guard(value: JsonValue): WorkflowGuard {
  const input = object(value, 'guard')
  if (input.kind === 'always') { fields(input, ['kind']); return { kind: 'always' } }
  if (input.kind !== 'equals') invalidDefinition('guard-kind')
  fields(input, ['kind', 'nodeKey', 'path', 'value'])
  const compared = input.value!
  if (typeof compared === 'object') invalidDefinition('guard-scalar')
  return { kind: 'equals', nodeKey: key(input.nodeKey, 'guard.nodeKey'), path: path(input.path, 'guard.path'), value: compared }
}
function output(value: JsonValue, limitsValue: WorkflowLimits): WorkflowOutput {
  const input = object(value, 'output')
  if (input.kind === 'text') { fields(input, ['kind', 'name']); return { kind: 'text', name: key(input.name, 'output.name') } }
  if (input.kind !== 'json') invalidDefinition('output-kind')
  fields(input, ['kind', 'schema', 'artifacts'])
  const artifacts = list(input.artifacts, 'artifacts', limitsValue.maxArtifactsPerAttempt).map(value => {
    const item = object(value, 'artifact'); fields(item, ['name', 'source'])
    const source = object(item.source, 'artifact.source')
    if (source.kind === 'json-text') { fields(source, ['kind', 'path']); return { name: key(item.name, 'artifact.name'),
      source: { kind: 'json-text' as const, path: path(source.path, 'artifact.path') } } }
    if (source.kind !== 'write-text') invalidDefinition('artifact-source')
    fields(source, ['kind', 'path'])
    return { name: key(item.name, 'artifact.name'), source: { kind: 'write-text' as const,
      path: text(source.path, 'artifact.path', 1024) } }
  })
  unique(artifacts.map(item => item.name), 'artifact.name')
  return { kind: 'json', schema: schema(input.schema, limitsValue), artifacts }
}
function acceptance(value: JsonValue, limitsValue: WorkflowLimits): WorkflowAcceptance {
  const input = object(value, 'acceptance')
  if (input.kind === 'schema-only') { fields(input, ['kind']); return { kind: 'schema-only' } }
  if (input.kind !== 'reviewed-all') invalidDefinition('acceptance-kind')
  fields(input, ['kind', 'reviewers'])
  const reviewers = strings(input.reviewers, 'reviewer', limitsValue.maxReviewersPerNode)
  if (!reviewers.length) invalidDefinition('reviewer-empty')
  return { kind: 'reviewed-all', reviewers }
}
function workspace(value: JsonValue, limitsValue: WorkflowLimits): WorkflowWorkspace {
  const input = object(value, 'workspace')
  if (input.kind === 'none') { fields(input, ['kind']); return { kind: 'none' } }
  if (input.kind !== 'shared-read' && input.kind !== 'exclusive-write') invalidDefinition('workspace-kind')
  fields(input, ['kind', 'resourceId', 'readFiles', 'writePrefixes'])
  const readFiles = list(input.readFiles, 'readFiles', limitsValue.maxNodes)
    .map(item => workspaceRelativePath(item, 1024))
  const writePrefixes = list(input.writePrefixes, 'writePrefixes', limitsValue.maxNodes)
    .map(item => workspaceRelativePath(item, 1024))
  unique(readFiles, 'readFile'); unique(writePrefixes, 'writePrefix')
  if (input.kind === 'shared-read' && writePrefixes.length) invalidDefinition('read-workspace-writes')
  return { kind: input.kind, resourceId: key(input.resourceId, 'resourceId'), readFiles, writePrefixes }
}
function attempt(value: JsonValue, limitsValue: WorkflowLimits): WorkflowAttempt {
  const input = object(value, 'attempt')
  fields(input, ['workerGrant', 'reviewerGrants', 'durationMs', 'retryDecisionMs', 'toolNames', 'nativeActions', 'workspace'])
  const reviewerGrants = list(input.reviewerGrants, 'reviewerGrants', limitsValue.maxReviewersPerNode).map(value => {
    const entry = object(value, 'reviewerGrant'); fields(entry, ['memberKey', 'grant'])
    return { memberKey: key(entry.memberKey, 'reviewer.memberKey'), grant: budget(entry.grant, 'reviewer') }
  })
  unique(reviewerGrants.map(item => item.memberKey), 'reviewerGrant')
  return { workerGrant: budget(input.workerGrant, 'worker'), reviewerGrants,
    durationMs: integer(input.durationMs, 'durationMs', 1), retryDecisionMs: integer(input.retryDecisionMs, 'retryDecisionMs', 1),
    toolNames: strings(input.toolNames, 'toolName', limitsValue.maxNodes),
    nativeActions: strings(input.nativeActions, 'nativeAction', limitsValue.maxNodes),
    workspace: workspace(input.workspace!, limitsValue) }
}
function node(value: JsonValue, limitsValue: WorkflowLimits): WorkflowNode {
  const input = object(value, 'node')
  fields(input, ['nodeKey', 'executor', 'task', 'dependencies', 'inputs', 'inputSchema', 'guard', 'output', 'acceptance', 'attempts'])
  const dependencies = list(input.dependencies, 'dependencies', limitsValue.maxEdges).map(dependency)
  unique(dependencies.map(item => item.nodeKey), 'dependency')
  const inputs = list(input.inputs, 'inputs', limitsValue.maxNodes).map(value => {
    const item = object(value, 'input'); fields(item, ['name', 'source'])
    return { name: key(item.name, 'input.name'), source: inputSource(item.source!) }
  })
  unique(inputs.map(item => item.name), 'input.name')
  const attempts = list(input.attempts, 'attempts', limitsValue.maxAttemptsPerNode).map(item => attempt(item, limitsValue))
  if (!attempts.length) invalidDefinition('attempts-empty')
  for (let index = 0; index < attempts.length; index++) {
    const current = attempts[index]!.workspace
    if (current.kind === 'none') continue
    for (const previous of attempts.slice(0, index).map(item => item.workspace)) {
      if (previous.kind === 'none' || previous.resourceId !== current.resourceId) continue
      if (previous.writePrefixes.some(left => current.writePrefixes.some(right => {
        const a = left.toLowerCase(), b = right.toLowerCase()
        return a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
      }))) invalidDefinition('attempt-output-overlap')
    }
  }
  return { nodeKey: key(input.nodeKey, 'nodeKey'), executor: key(input.executor, 'executor'),
    task: text(input.task, 'task', limitsValue.maxTextBytes), dependencies, inputs,
    inputSchema: schema(input.inputSchema, limitsValue), guard: guard(input.guard!), output: output(input.output!, limitsValue),
    acceptance: acceptance(input.acceptance!, limitsValue), attempts }
}

/** Decode a finite immutable workflow definition before any Host resource is acquired. */
export function decodeWorkflowDefinition(value: unknown, ceiling: WorkflowLimits = DEFAULT_WORKFLOW_LIMITS): WorkflowDefinition {
  try { return decodeDefinition(value, ceiling) }
  catch (cause) {
    if (cause instanceof JsonBoundaryError || cause instanceof InlineSchemaError || cause instanceof SessionError
      || cause instanceof ToolError) {
      invalidDefinition('invalid-value')
    }
    throw cause
  }
}

function decodeDefinition(value: unknown, ceiling: WorkflowLimits): WorkflowDefinition {
  const data = boundedJson(value, { maxBytes: ceiling.maxDefinitionBytes, maxDepth: ceiling.maxSchemaDepth + 8,
    maxNodes: ceiling.maxSchemaNodes + ceiling.maxNodes * 32 })
  const input = object(data, 'workflow')
  fields(input, ['version', 'workflowKey', 'coordinator', 'roster', 'communication', 'nodes', 'requiredOutputs', 'deadline', 'budget', 'limits', 'failurePolicy'])
  if (input.version !== 1 || input.failurePolicy !== 'fail-fast') invalidDefinition('version-or-failure-policy')
  const ownLimits = limits(input.limits, ceiling)
  if (Buffer.byteLength(JSON.stringify(data)) > ownLimits.maxDefinitionBytes) invalidDefinition('definition-bytes')
  const roster = list(input.roster, 'roster', ownLimits.maxMembers).map(item => member(item, ownLimits.maxMembers))
  unique(roster.map(item => item.memberKey), 'memberKey'); unique(roster.map(item => item.address), 'memberAddress')
  const nodes = list(input.nodes, 'nodes', ownLimits.maxNodes).map(item => node(item, ownLimits))
  if (!nodes.length) invalidDefinition('nodes-empty')
  unique(nodes.map(item => item.nodeKey), 'nodeKey')
  const requiredOutputs = strings(input.requiredOutputs, 'requiredOutput', ownLimits.maxNodes)
  if (!requiredOutputs.length) invalidDefinition('requiredOutputs-empty')
  const deadline = text(input.deadline, 'deadline', 40)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(deadline) || !Number.isFinite(Date.parse(deadline))
    || new Date(deadline).toISOString() !== deadline) {
    invalidDefinition('deadline')
  }
  const coordinator = formatSessionAddress(parseSessionAddress(text(input.coordinator, 'coordinator', 64)))
  const definition: WorkflowDefinition = { version: 1, workflowKey: key(input.workflowKey, 'workflowKey'),
    coordinator, roster, communication: communication(input.communication, ownLimits), nodes, requiredOutputs,
    deadline, budget: budget(input.budget, 'workflow'),
    limits: ownLimits, failurePolicy: 'fail-fast' }
  validateWorkflowGraph(definition)
  if (roster.some(item => item.address === coordinator)) invalidDefinition('coordinator-as-peer')
  return snapshotJson(definition) as unknown as WorkflowDefinition
}

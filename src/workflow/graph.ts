import { Ajv2020 } from 'ajv/dist/2020.js'
import { budgetFields } from '../agent/budget.js'
import type { AgentBudget } from '../agent/contract.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { boundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import { validationData, validationSchema } from '../schema/validation-keys.js'
import { invalidDefinition } from './errors.js'
import type { WorkflowDefinition, WorkflowNode } from './types.js'

/** Check role references, direct inputs, reviewer grants, and all dependency cycles. */
export function validateWorkflowGraph(definition: WorkflowDefinition): void {
  const fits = (grant: AgentBudget, ceiling: AgentBudget): boolean =>
    budgetFields.every(field => grant[field] <= ceiling[field])
  const members = new Map(definition.roster.map(item => [item.memberKey, item]))
  const nodes = new Map(definition.nodes.map(item => [item.nodeKey, item]))
  for (const item of definition.communication.ask) {
    if (item.from === item.to || !members.has(item.from) || !members.has(item.to)) invalidDefinition('ask-direction')
  }
  for (const item of definition.communication.groups) {
    if (!members.has(item.from) || item.recipients.some(key => key === item.from || !members.has(key))) invalidDefinition('group-scope')
  }
  if (definition.communication.disclosures.length !== definition.nodes.length) invalidDefinition('disclosure-count')
  for (const item of definition.communication.disclosures) {
    if (!nodes.has(item.nodeKey) || !item.recipients.includes('coordinator')
      || item.recipients.some(key => key !== 'coordinator' && !members.has(key))) invalidDefinition('disclosure-scope')
  }
  if (definition.nodes.reduce((sum, item) => sum + item.dependencies.length, 0) > definition.limits.maxEdges) invalidDefinition('edge-limit')
  for (const keyValue of definition.requiredOutputs) if (!nodes.has(keyValue)) invalidDefinition('unknown-required-output')
  for (const item of definition.nodes) {
    if (!members.get(item.executor)?.canProduce) invalidDefinition('executor-permission')
    const direct = new Map(item.dependencies.map(edge => [edge.nodeKey, edge.mode]))
    for (const edge of item.dependencies) if (edge.nodeKey === item.nodeKey || !nodes.has(edge.nodeKey)) invalidDefinition('dependency-reference')
    if (item.guard.kind === 'equals' && direct.get(item.guard.nodeKey) !== 'required') invalidDefinition('guard-dependency')
    for (const source of item.inputs.map(entry => entry.source)) if (source.kind === 'accepted') {
      const mode = direct.get(source.nodeKey)
      if (mode === undefined || (mode === 'required') === Object.hasOwn(source, 'fallback')) invalidDefinition('input-dependency')
    }
    const reviewers = item.acceptance.kind === 'reviewed-all' ? item.acceptance.reviewers : []
    for (const reviewer of reviewers) if (!members.get(reviewer)?.canReview || reviewer === item.executor) invalidDefinition('reviewer-permission')
    const disclosed = definition.communication.disclosures.find(entry => entry.nodeKey === item.nodeKey)!.recipients
    if (reviewers.some(reviewer => !disclosed.includes(reviewer))) invalidDefinition('review-disclosure')
    for (const downstream of definition.nodes) {
      if (downstream.inputs.some(entry => entry.source.kind === 'accepted' && entry.source.nodeKey === item.nodeKey)
        && !disclosed.includes(downstream.executor)) invalidDefinition('downstream-disclosure')
    }
    for (const trial of item.attempts) {
      if (trial.reviewerGrants.length !== reviewers.length || trial.reviewerGrants.some((entry, index) => entry.memberKey !== reviewers[index])) {
        invalidDefinition('reviewer-grants')
      }
      if (!fits(trial.workerGrant, members.get(item.executor)!.budgetCeiling)
        || trial.reviewerGrants.some(entry => !fits(entry.grant, members.get(entry.memberKey)!.budgetCeiling))) {
        invalidDefinition('member-budget')
      }
      if (trial.workspace.kind !== 'none' && !members.get(item.executor)!.resourceIds.includes(trial.workspace.resourceId)) {
        invalidDefinition('member-workspace')
      }
    }
  }
  const marks = new Map<string, 0 | 1 | 2>()
  const visit = (keyValue: string): void => {
    const mark = marks.get(keyValue)
    if (mark === 1) invalidDefinition('dependency-cycle')
    if (mark === 2) return
    marks.set(keyValue, 1)
    for (const edge of nodes.get(keyValue)!.dependencies) visit(edge.nodeKey)
    marks.set(keyValue, 2)
  }
  for (const item of definition.nodes) visit(item.nodeKey)
}

export type WorkflowUpstreamState = { readonly kind: 'accepted'; readonly value: JsonValue }
  | { readonly kind: 'skipped' | 'failed' | 'cancelled' | 'result-unknown' }
export type WorkflowResolution = { readonly kind: 'blocked' | 'skipped' | 'failed'; readonly reason: string }
  | { readonly kind: 'ready'; readonly inputs: JsonObject }

function fieldPath(value: JsonValue, path: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, segment)) return undefined
    current = (current as JsonObject)[segment]
  }
  return current
}

/** Determine one node's next data decision from accepted direct predecessors. */
export function resolveWorkflowNode(node: WorkflowNode, upstream: ReadonlyMap<string, WorkflowUpstreamState>,
  definition: WorkflowDefinition): WorkflowResolution {
  for (const edge of node.dependencies) {
    const source = upstream.get(edge.nodeKey)
    if (source === undefined) return { kind: 'blocked', reason: 'dependency-pending' }
    if (source.kind === 'skipped' && edge.mode === 'required') return { kind: 'skipped', reason: 'required-dependency-skipped' }
    if (source.kind !== 'accepted' && source.kind !== 'skipped') return { kind: 'failed', reason: 'dependency-failed' }
  }
  if (node.guard.kind === 'equals') {
    const source = upstream.get(node.guard.nodeKey)
    if (source?.kind !== 'accepted') return { kind: 'failed', reason: 'guard-source' }
    const actual = fieldPath(source.value, node.guard.path)
    if (actual === undefined || (actual === null) !== (node.guard.value === null)
      || actual !== null && typeof actual !== typeof node.guard.value) return { kind: 'failed', reason: 'guard-value' }
    if (actual !== node.guard.value) return { kind: 'skipped', reason: 'guard-false' }
  }
  const inputs: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const entry of node.inputs) {
    if (entry.source.kind === 'literal') { inputs[entry.name] = entry.source.value; continue }
    const source = upstream.get(entry.source.nodeKey)
    if (source?.kind === 'skipped') {
      if (!Object.hasOwn(entry.source, 'fallback')) return { kind: 'failed', reason: 'input-fallback' }
      inputs[entry.name] = entry.source.fallback!
    } else if (source?.kind === 'accepted') {
      const selected = fieldPath(source.value, entry.source.path)
      if (selected === undefined) return { kind: 'failed', reason: 'input-path' }
      inputs[entry.name] = selected
    } else return { kind: 'failed', reason: 'input-source' }
  }
  let checked: JsonValue
  try { checked = boundedJson(inputs, { maxBytes: definition.limits.maxValueBytes,
    maxDepth: definition.limits.maxSchemaDepth, maxNodes: definition.limits.maxSchemaNodes }) }
  catch (cause) {
    if (cause instanceof JsonBoundaryError) return { kind: 'failed', reason: 'input-limit' }
    throw cause
  }
  const ajv = new Ajv2020({ strict: true, ownProperties: true, $data: false, allErrors: false,
    coerceTypes: false, useDefaults: false, removeAdditional: false, validateSchema: true,
    addUsedSchema: false, inlineRefs: false })
  const valid = ajv.compile(validationSchema(node.inputSchema))
  if (!valid(validationData(checked))) return { kind: 'failed', reason: 'input-schema' }
  return { kind: 'ready', inputs: checked as JsonObject }
}

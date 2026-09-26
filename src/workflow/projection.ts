import type { SessionSnapshot, StoredSessionEvent } from '../session/types.js'
import { emptyAgentBudget, reserveAgentBudget } from '../agent/budget.js'
import type { AgentBudget } from '../agent/contract.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import { invalidHistory } from './errors.js'
import { resolveWorkflowNode } from './graph.js'
import { workflowAssignmentMailboxDemand } from './protocol-capacity.js'
import { workflowAssignmentCommittedEvent, workflowDefinitionRecordedEvent, workflowNodeResolvedEvent } from './session-events.js'
import type { WorkflowAssignment, WorkflowDefinition } from './types.js'
import type { WorkflowNodeResolved } from './session-events.js'

export interface WorkflowSnapshot {
  readonly definition: { readonly stored: StoredSessionEvent; readonly payload: WorkflowDefinition } | null
  readonly ready: readonly string[]
  readonly resolved: readonly WorkflowNodeResolved[]
  readonly assignments: readonly { readonly stored: StoredSessionEvent; readonly payload: WorkflowAssignment }[]
  readonly reservedBudget: AgentBudget
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.compare(canonicalJsonBytes(left as JsonValue), canonicalJsonBytes(right as JsonValue)) === 0
}

/** Rebuild the coordinator's admitted definition and initially ready work. */
export function projectWorkflowSession(snapshot: SessionSnapshot): WorkflowSnapshot {
  if (snapshot.header.parent !== undefined) invalidHistory('coordinator-fork')
  const local = snapshot.history.at(-1)
  if (local?.header.sessionId !== snapshot.header.sessionId) invalidHistory('coordinator-history')
  let definition: WorkflowSnapshot['definition'] = null
  const resolved = new Map<string, WorkflowNodeResolved>()
  const assignments: WorkflowSnapshot['assignments'][number][] = []
  let reservedBudget: AgentBudget = emptyAgentBudget
  for (const record of local.events) {
    if (record.kind !== 'known') continue
    if (record.stored.type === workflowDefinitionRecordedEvent.type) {
      if (record.stored.payloadVersion !== 1 || definition !== null || resolved.size || assignments.length) invalidHistory('definition-duplicate-or-version')
      const payload = workflowDefinitionRecordedEvent.decode(record.payload)
      const value = payload.definition as unknown as WorkflowDefinition
      if (value.coordinator !== snapshot.header.address) invalidHistory('coordinator-address')
      definition = { ...record, payload: value }
    } else if (record.stored.type === workflowNodeResolvedEvent.type) {
      if (record.stored.payloadVersion !== 1 || definition === null) invalidHistory('resolution-before-definition')
      const payload = workflowNodeResolvedEvent.decode(record.payload)
      if (payload.definition !== definition.stored.eventId || resolved.has(payload.nodeKey)
        || !definition.payload.nodes.some(node => node.nodeKey === payload.nodeKey)) invalidHistory('resolution-conflict')
      const node = definition.payload.nodes.find(item => item.nodeKey === payload.nodeKey)!
      const result = resolveWorkflowNode(node, new Map(), definition.payload)
      if (result.kind !== payload.outcome || result.reason !== payload.reason) invalidHistory('resolution-not-derived')
      resolved.set(payload.nodeKey, payload)
    } else if (record.stored.type === workflowAssignmentCommittedEvent.type) {
      if (record.stored.payloadVersion !== 1 || definition === null) invalidHistory('assignment-before-definition')
      const payload = workflowAssignmentCommittedEvent.decode(record.payload)
      const recipe = definition.payload
      const node = recipe.nodes.find(item => item.nodeKey === payload.nodeKey)
      const attempt = node?.attempts[payload.attempt - 1]
      if (payload.definition !== definition.stored.eventId || node === undefined || attempt === undefined
        || resolved.has(payload.nodeKey) || assignments.some(item => item.payload.nodeKey === payload.nodeKey)
        || assignments.length >= recipe.limits.maxActiveAssignments) invalidHistory('assignment-not-admissible')
      const member = recipe.roster.find(item => item.memberKey === node.executor)
      const selected = resolveWorkflowNode(node, new Map(), recipe)
      const demand = workflowAssignmentMailboxDemand(recipe, 'production')
      if (selected.kind !== 'ready' || payload.memberKey !== node.executor || payload.memberAddress !== member?.address
        || payload.sourceAccepted.length !== 0 || !same(payload.inputs, selected.inputs)
        || !same(payload.effectiveAllowance, attempt.workerGrant)
        || !same(payload.reviewerReservations, attempt.reviewerGrants)
        || !same(payload.toolNames, attempt.toolNames) || !same(payload.nativeActions, attempt.nativeActions)
        || !same(payload.workspace, attempt.workspace) || payload.workspace.kind !== 'none' || payload.workspaceBaseline !== null
        || !same(payload.protocolReserve, demand) || !same(payload.acceptance, node.acceptance)) invalidHistory('assignment-recipe-mismatch')
      const until = Math.min(Date.parse(recipe.deadline), Date.parse(record.stored.recordedAt) + attempt.durationMs)
      if (Date.parse(payload.deadline) > until) invalidHistory('assignment-deadline')
      let next: AgentBudget | null = reserveAgentBudget(reservedBudget, attempt.workerGrant, recipe.budget)
      for (const reviewer of attempt.reviewerGrants) {
        if (next === null) break
        next = reserveAgentBudget(next, reviewer.grant, recipe.budget)
      }
      if (next === null) invalidHistory('workflow-budget-exceeded')
      reservedBudget = next
      assignments.push({ stored: record.stored, payload })
    }
  }
  return Object.freeze({ definition,
    ready: definition?.payload.nodes.filter(node => node.dependencies.length === 0 && !resolved.has(node.nodeKey)
      && !assignments.some(item => item.payload.nodeKey === node.nodeKey)).map(node => node.nodeKey) ?? [],
    resolved: Object.freeze([...resolved.values()]), assignments: Object.freeze(assignments), reservedBudget })
}

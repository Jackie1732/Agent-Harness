import { workflowControlRequestedEvent, workflowControlSettledEvent } from './control-events.js'
import type { WorkflowControlRequested, WorkflowControlSettled } from './control-events.js'
import { validateWorkflowProtocol, workflowProtocolRecordedEvent } from './protocol.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'
import { workflowDecisionCommittedEvent, workflowProposalReceivedEvent } from './coordinator-events.js'
import type { WorkflowDecisionCommitted, WorkflowProposalReceived } from './coordinator-events.js'
import type { WorkflowUpstreamState } from './graph.js'
import { validateWorkflowProposal } from './proposal-validation.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
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
  readonly controls: readonly { readonly requested: CommittedSessionEvent<WorkflowControlRequested & import('../foundation/json.js').JsonObject>; readonly settled: CommittedSessionEvent<WorkflowControlSettled & import('../foundation/json.js').JsonObject> | null }[]
  readonly desired: 'paused' | 'running'
  readonly proposals: readonly CommittedSessionEvent<WorkflowProposalReceived & import('../foundation/json.js').JsonObject>[]
  readonly decisions: readonly CommittedSessionEvent<WorkflowDecisionCommitted & import('../foundation/json.js').JsonObject>[]
  readonly upstream: readonly { readonly nodeKey: string; readonly state: WorkflowUpstreamState }[]
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
  const controls: { requested: WorkflowSnapshot['controls'][number]['requested']; settled: WorkflowSnapshot['controls'][number]['settled'] }[] = []
  let desired: WorkflowSnapshot['desired'] = 'paused'
  const proposals: WorkflowSnapshot['proposals'][number][] = []
  const decisions: WorkflowSnapshot['decisions'][number][] = []
  const upstream = new Map<string, WorkflowUpstreamState>()
  const sources = new Map<SessionEventId, CommittedSessionEvent>()
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
      const result = resolveWorkflowNode(node, upstream, definition.payload)
      if (result.kind !== payload.outcome || result.reason !== payload.reason) invalidHistory('resolution-not-derived')
      if (assignments.some(item => item.payload.nodeKey === payload.nodeKey)) invalidHistory('resolution-after-assignment')
      resolved.set(payload.nodeKey, payload)
      upstream.set(payload.nodeKey, { kind: payload.outcome })
    } else if (record.stored.type === workflowAssignmentCommittedEvent.type) {
      if (record.stored.payloadVersion !== 1 || definition === null) invalidHistory('assignment-before-definition')
      const payload = workflowAssignmentCommittedEvent.decode(record.payload)
      const recipe = definition.payload
      const node = recipe.nodes.find(item => item.nodeKey === payload.nodeKey)
      const attempt = node?.attempts[payload.attempt - 1]
      if (payload.definition !== definition.stored.eventId || node === undefined || attempt === undefined
        || resolved.has(payload.nodeKey) || assignments.some(item => item.payload.nodeKey === payload.nodeKey)
        || assignments.filter(item => !decisions.some(decision => decision.payload.assignment.eventId === item.stored.eventId)).length >= recipe.limits.maxActiveAssignments) invalidHistory('assignment-not-admissible')
      const member = recipe.roster.find(item => item.memberKey === node.executor)
      const selected = resolveWorkflowNode(node, upstream, recipe)
      const demand = workflowAssignmentMailboxDemand(recipe, 'production')
      if (selected.kind !== 'ready' || payload.memberKey !== node.executor || payload.memberAddress !== member?.address
        || !same(payload.sourceAccepted, decisions.filter(item => node.inputs.some(input => input.source.kind === 'accepted'
          && assignments.find(assignment => assignment.stored.eventId === item.payload.assignment.eventId)?.payload.nodeKey === input.source.nodeKey))
          .map(item => ({ address: recipe.coordinator, eventId: item.stored.eventId }))) || !same(payload.inputs, selected.inputs)
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
    } else if (record.stored.type === workflowProposalReceivedEvent.type) {
      if (record.stored.payloadVersion !== 1 || definition === null) invalidHistory('proposal-before-definition')
      const payload = workflowProposalReceivedEvent.decode(record.payload)
      const assignment = assignments.find(item => item.stored.eventId === payload.message.assignment.eventId)
      const inbox = sources.get(payload.inbox)
      if (assignment === undefined || payload.definition !== definition.stored.eventId || inbox?.stored.type !== inboxAcceptedEvent.type
        || proposals.some(item => same(item.payload.message.assignment, payload.message.assignment))) invalidHistory('proposal-source')
      const envelope = inboxAcceptedEvent.decode(inbox.payload).envelope
      if (envelope.type !== 'workflow/proposal' || envelope.payloadVersion !== 1 || envelope.sender !== assignment.payload.memberAddress
        || envelope.recipient !== definition.payload.coordinator || envelope.channelId !== assignment.payload.channelId
        || !same(envelope.payload, payload.message)) invalidHistory('proposal-inbox')
      validateWorkflowProposal(definition.payload, assignment.payload,
        { address: definition.payload.coordinator, eventId: assignment.stored.eventId }, payload.message)
      proposals.push({ ...record, payload })
      const total = proposals.flatMap(item => item.payload.message.artifacts).reduce((sum, item) => sum + item.value.byteLength, 0)
      if (total > definition.payload.limits.maxTotalArtifactBytes) invalidHistory('workflow-artifact-total')
    } else if (record.stored.type === workflowDecisionCommittedEvent.type) {
      if (record.stored.payloadVersion !== 1 || definition === null) invalidHistory('decision-before-definition')
      const payload = workflowDecisionCommittedEvent.decode(record.payload)
      const assignment = assignments.find(item => item.stored.eventId === payload.assignment.eventId)
      const received = proposals.find(item => same(item.payload.message.proposal, payload.proposal))
      if (assignment === undefined || received === undefined || payload.definition !== definition.stored.eventId
        || !same(received.payload.message.assignment, payload.assignment)
        || decisions.some(item => same(item.payload.assignment, payload.assignment))
        || (received.payload.message.value.outcome === 'completed' ? assignment.payload.acceptance.kind !== 'schema-only' || payload.outcome !== 'accepted' : payload.outcome !== 'rejected') || payload.reviews.length !== 0
        || !same(payload.value, received.payload.message.value.value) || !same(payload.artifacts, received.payload.message.value.artifacts)) invalidHistory('decision-source')
      decisions.push({ ...record, payload })
      upstream.set(assignment.payload.nodeKey, payload.outcome === 'accepted' ? { kind: 'accepted', value: payload.value }
        : { kind: received.payload.message.value.outcome === 'result-unknown' ? 'result-unknown' : 'failed' })
    }
    if (record.stored.type === workflowControlRequestedEvent.type) {
      const payload = workflowControlRequestedEvent.decode(record.payload)
      if (record.stored.payloadVersion !== 1 || payload.definition !== definition?.stored.eventId
        || controls.some(item => item.requested.payload.requestKey === payload.requestKey || item.settled === null)) invalidHistory('workflow-control-conflict')
      controls.push({ requested: { ...record, payload }, settled: null })
    } else if (record.stored.type === workflowControlSettledEvent.type) {
      const payload = workflowControlSettledEvent.decode(record.payload)
      const control = controls.at(-1)
      if (record.stored.payloadVersion !== 1 || control === undefined || control.settled !== null || control.requested.stored.eventId !== payload.request) invalidHistory('workflow-control-settlement')
      control.settled = { ...record, payload }
      desired = control.requested.payload.kind === 'resume' ? 'running' : 'paused'
    }
    if (record.stored.type === workflowProtocolRecordedEvent.type) validateWorkflowProtocol(sources, record)
    sources.set(record.stored.eventId, record)
  }
  return Object.freeze({ definition,
    ready: definition?.payload.nodes.filter(node => resolveWorkflowNode(node, upstream, definition!.payload).kind === 'ready' && !resolved.has(node.nodeKey)
      && !assignments.some(item => item.payload.nodeKey === node.nodeKey)).map(node => node.nodeKey) ?? [],
    controls: Object.freeze(controls), desired, proposals: Object.freeze(proposals), decisions: Object.freeze(decisions), upstream: Object.freeze([...upstream].map(([nodeKey, state]) => Object.freeze({ nodeKey, state }))),
    resolved: Object.freeze([...resolved.values()]), assignments: Object.freeze(assignments), reservedBudget })
}

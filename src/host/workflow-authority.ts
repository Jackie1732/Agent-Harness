import { createHash } from 'node:crypto'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject } from '../foundation/json.js'
import { projectAgentSession } from '../agent/projection.js'
import { reserveAgentBudget, emptyAgentBudget } from '../agent/budget.js'
import type { WorkflowAssignment, WorkflowDefinition } from '../workflow/types.js'
import type { ResolvedHostLocalMember } from './config.js'
import type { HostSlot } from './runtime-types.js'
import { HostError } from './errors.js'
import { assertWorkTools } from './workflow-workspace.js'

/** Roster hashes cover resolved Spec fields without its local profile EventId, and the complete Context profile. */
export function workflowMemberFingerprints(member: ResolvedHostLocalMember) {
  const hash = (value: unknown) => createHash('sha256').update(canonicalJsonBytes(value as JsonObject)).digest('hex')
  return { specFingerprint: hash(member.spec), contextFingerprint: hash(member.profile) }
}

/** Verify actual installed membership and the exact attempt grant before CP-W. */
export function assertWorkflowMember(definition: WorkflowDefinition, slot: HostSlot, nodeKey: string): void {
  const node = definition.nodes.find(node => node.nodeKey === nodeKey)!
  const authority = assertWorkflowParticipant(definition, slot, node.executor)
  const attempt = node.attempts[0]!
  assertWorkTools(slot.member, attempt)
  if (attempt.toolNames.some(name => !authority.toolNames.includes(name))
    || attempt.nativeActions.some(name => !(authority.nativeActions as readonly string[]).includes(name))
    || attempt.workspace.kind !== 'none' && !authority.resourceIds.includes(attempt.workspace.resourceId)) throw new HostError('HOST_BINDING_CONFLICT', 'workflow-attempt-authority')
}

/** Review execution uses the same installed participant identity with a separately reserved grant. */
export function assertWorkflowParticipant(definition: WorkflowDefinition, slot: HostSlot, memberKey: string) {
  const roster = definition.roster.find(item => item.memberKey === memberKey)!
  const spec = slot.member.spec
  const hashes = workflowMemberFingerprints(slot.member)
  if (spec.protocolVersion !== 3 || spec.workflow.kind !== 'participant' || roster.address !== slot.session.header.address
    || roster.specFingerprint !== hashes.specFingerprint || roster.contextFingerprint !== hashes.contextFingerprint
    || reserveAgentBudget(emptyAgentBudget, roster.budgetCeiling, spec.budget) === null) throw new HostError('HOST_BINDING_CONFLICT', 'workflow-member-authority')
  return spec.workflow
}

export function workflowMemberIdle(slot: HostSlot): boolean {
  const state = projectAgentSession(slot.session.snapshot())
  return slot.agent.status === 'accepting' && state.openRun === null && state.openRecovery === null && state.closing === null
    && !state.roots.some(root => root.outcome === null)
    && !state.inputs.some(input => input.work !== undefined && input.status === 'queued')
}

export function assignmentMember(slots: readonly HostSlot[], assignment: WorkflowAssignment): HostSlot {
  const slot = slots.find(slot => slot.session.header.address === assignment.memberAddress)
  if (slot === undefined) throw new HostError('HOST_NOT_READY', 'workflow-member-offline')
  return slot
}

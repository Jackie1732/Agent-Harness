import { WorkflowError } from '../workflow/errors.js'
import { SessionWorkActions } from '../workflow/actions.js'
import { admitWorkQuestion, nextWorkInteractionSettlement } from './workflow-interactions.js'
import { nextWorkQuestionDecline } from '../workflow/question-decline.js'
import { randomUUID } from 'node:crypto'
import { SerialGate } from '../foundation/serial-gate.js'
import type { Clock } from '../foundation/clock.js'
import type { CommunicationService } from '../communication/service.js'
import { parseChannelId } from '../communication/ids.js'
import { projectAgentSession, foldAgentSession } from '../agent/projection.js'
import { AgentJournal } from '../agent/journal.js'
import { sessionDelegationsClosed } from '../subagent/closure.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { WorkflowAdmission } from '../workflow/admission.js'
import { WorkflowJournal } from '../workflow/journal.js'
import { workflowAssignmentClosed } from '../workflow/closure.js'
import { sameWorkflowValue, workflowReference } from '../workflow/work-binding.js'
import { workExecutionReleasedEvent } from '../workflow/result-events.js'
import { workflowDecisionCommittedEvent } from '../workflow/coordinator-events.js'
import { workflowNodeResolvedEvent } from '../workflow/definition-events.js'
import { resolveWorkflowNode } from '../workflow/graph.js'
import { workflowControlRequestedEvent, workflowControlSettledEvent } from '../workflow/control-events.js'
import { nextWorkPublication } from '../workflow/publication.js'
import { nextWorkflowSend } from '../workflow/transport-maintenance.js'
import { HostError } from './errors.js'
import type { HostSlot, HostProtocolSlot } from './runtime-types.js'
import { nextWorkflowInbox } from './workflow-inbox.js'
import { assignmentMember, assertWorkflowMember, assertWorkflowParticipant, workflowMemberIdle } from './workflow-authority.js'
import { resolveWorkflowReviews } from '../workflow/review.js'
import { workflowReport } from './workflow-report.js'
import { prepareWorkWorkspace, workExecutionTools } from './workflow-workspace.js'
import type { WorkspaceAuthority, WorkspaceLease } from '../subagent/workspace.js'

interface WorkflowEntry { readonly slot: HostProtocolSlot; readonly journal: WorkflowJournal; readonly admission: WorkflowAdmission }

/** Host-owned admission and one-transition maintenance across independent coordinator Sessions. */
export class HostWorkflows {
  readonly #gate = new SerialGate()
  readonly #entries = new Map<string, WorkflowEntry>()
  readonly #active = new Set<string>()
  readonly #retired = new Set<string>()
  readonly #workspaces = new Map<string, WorkspaceLease>()
  #cursor = 0
  #closed = false
  constructor(readonly slots: HostSlot[], coordinators: readonly HostProtocolSlot[], readonly communication: CommunicationService,
    readonly clock: Clock, readonly owner: string, readonly workspaceAuthority: WorkspaceAuthority) {
    for (const slot of coordinators) {
      const definition = projectWorkflowSession(slot.session.snapshot()).definition!
      this.#entries.set(definition.payload.workflowKey, { slot, journal: new WorkflowJournal(slot.session, clock),
        admission: new WorkflowAdmission(slot.session, communication.protocolCapacity, clock) })
    }
  }

  async restore(): Promise<void> {
    for (const entry of this.#entries.values()) for (const assignment of projectWorkflowSession(entry.slot.session.snapshot()).assignments) {
      const member = assignmentMember(this.slots, assignment.payload)
      if (workflowAssignmentClosed(entry.slot.session, member.session, assignment.stored.eventId, this.slots.map(slot => slot.session))) { this.#retired.add(assignment.stored.eventId); continue }
      await entry.admission.restore({ kind: 'known', stored: assignment.stored, payload: assignment.payload as typeof assignment.payload & import('../foundation/json.js').JsonObject }, member.session)
      this.communication.workflowChannels.bind(entry.slot.session, assignment.stored.eventId, member.session)
    }
  }

  report(key: string) { return workflowReport(this.#entry(key).slot.session, this.slots, this.#active.has(key)) }

  readArtifact(key: string, reference: unknown) {
    const ref = workflowReference(reference)
    const state = projectWorkflowSession(this.#entry(key).slot.session.snapshot())
    const copy = state.proposals.flatMap(item => item.payload.message.artifacts).find(item => sameWorkflowValue(item.ref, ref))
    if (copy === undefined) throw new HostError('HOST_NOT_READY', 'workflow-artifact-not-disclosed')
    return copy
  }

  control(key: string, kind: 'pause' | 'resume', input: { readonly requestKey: string; readonly reason?: string }) {
    return this.#gate.run(async () => {
      if (this.#closed) throw new HostError('HOST_INACTIVE', 'workflow-host-closed')
      const entry = this.#entry(key)
      const state = projectWorkflowSession(entry.slot.session.snapshot())
      const payload = workflowControlRequestedEvent.decode({ definition: state.definition!.stored.eventId, kind,
        requestKey: input.requestKey, reason: input.reason ?? '' })
      const prior = state.controls.find(item => item.requested.payload.requestKey === input.requestKey)
      if (prior !== undefined && !sameWorkflowValue(prior.requested.payload, payload)) throw new HostError('HOST_BINDING_CONFLICT', 'workflow-request-key-conflict')
      const requested = prior?.requested ?? await entry.journal.append(workflowControlRequestedEvent, () => payload)
      const settled = prior?.settled ?? await entry.journal.append(workflowControlSettledEvent, () => ({ request: requested.stored.eventId, outcome: 'applied' as const, owner: this.owner }))
      const latest = projectWorkflowSession(entry.slot.session.snapshot()).controls.at(-1)
      if (latest?.requested.stored.eventId === requested.stored.eventId && kind === 'resume') this.#active.add(key)
      return { status: kind === 'resume' && latest?.requested.stored.eventId === requested.stored.eventId ? 'resumed' as const : 'applied' as const,
        ref: { address: entry.slot.session.header.address, eventId: settled.stored.eventId } }
    })
  }

  businessAllowed(slot: HostSlot): boolean {
    for (const [key, entry] of this.#entries) {
      const state = projectWorkflowSession(entry.slot.session.snapshot())
      const assignment = state.assignments.find(item => item.payload.memberAddress === slot.session.header.address && !this.#retired.has(item.stored.eventId))
      if (assignment === undefined) continue
      return !this.#closed && this.#active.has(key) && state.desired === 'running'
        && slot.selection?.kind === 'workflow' && slot.selection.assignment.eventId === assignment.stored.eventId
    }
    return slot.selection?.kind !== 'workflow'
  }

  nextAction(): (() => Promise<unknown>) | undefined {
    if (this.#closed) return undefined
    const entries = [...this.#entries]
    for (let offset = 0; offset < entries.length; offset++) {
      const index = (this.#cursor + offset) % entries.length
      const [key, entry] = entries[index]!
      if (!this.#active.has(key)) continue
      const action = this.#next(entry)
      if (action !== undefined) return () => this.#gate.run(async () => {
        this.#cursor = (index + 1) % entries.length
        return this.#closed ? undefined : this.#next(entry)?.()
      })
    }
    return undefined
  }

  #next(entry: WorkflowEntry): (() => Promise<unknown>) | undefined {
    const coordinator = entry.slot
    const state = projectWorkflowSession(coordinator.session.snapshot())
    const definition = state.definition!
    const protocol = nextWorkflowInbox(coordinator.session, coordinator.mailbox, this.clock, 'coordinator')
      ?? nextWorkflowSend(coordinator.session, coordinator.mailbox, this.clock, 'coordinator')
      ?? nextWorkInteractionSettlement(coordinator.session, this.slots, this.clock)
    if (protocol !== undefined) return protocol
    for (const member of this.slots.filter(member => definition.payload.roster.some(peer => peer.address === member.session.header.address))) {
      const incoming = nextWorkflowInbox(member.session, member.mailbox, this.clock, 'member')
        ?? nextWorkQuestionDecline(member.session, this.clock)
        ?? nextWorkflowSend(member.session, member.mailbox, this.clock, 'member')
      if (incoming !== undefined) return incoming
    }
    for (const work of state.assignments) {
      if (this.#retired.has(work.stored.eventId)) continue
      const member = assignmentMember(this.slots, work.payload)
      const agent = projectAgentSession(member.session.snapshot())
      const accepted = agent.inputs.find(input => input.work?.assignment.eventId === work.stored.eventId)
      if (accepted === undefined) continue
      const root = agent.roots.find(root => root.source.kind === 'workflow' && root.source.assignment.eventId === work.stored.eventId)
      if (root?.outcome == null) {
        if (state.desired === 'running' && member.selection?.kind !== 'workflow') return async () => {
          const lease = this.#workspaces.get(work.stored.eventId) ?? await prepareWorkWorkspace(member.member, work.payload, this.workspaceAuthority, work.payload.workspaceBaseline)
          if (lease !== undefined) this.#workspaces.set(work.stored.eventId, lease)
          const replacement = await member.executions!.replace({ kind: 'workflow', assignment: accepted.work!.assignment }, {
            ...workExecutionTools(member.member, work.payload, lease), workActions: new SessionWorkActions(member.session, this.clock, {
              admit: request => this.#gate.run(async () => this.#closed || projectWorkflowSession(coordinator.session.snapshot()).desired !== 'running'
                ? { outcome: 'blocked' as const, reason: 'workflow-admission-paused', cycle: [] }
                : admitWorkQuestion(coordinator.session, this.slots, this.clock, request)),
            }),
          })
          this.slots[this.slots.indexOf(member)] = replacement
        }
        continue
      }
      const sources = foldAgentSession(member.session.snapshot())
      const released = [...sources.sources.values()].find(item => item.stored.type === workExecutionReleasedEvent.type
        && workExecutionReleasedEvent.decode(item.payload).accepted === accepted.reference.eventId)
      if (released === undefined) {
        if (!sessionDelegationsClosed(sources, [...sources.sources.values()])) continue
        return async () => {
          let outcome: 'released' | 'unknown' = 'released'
          let failure: unknown
          try { await member.executions!.release() }
          catch (cause) { outcome = 'unknown'; failure = cause }
          await new AgentJournal(member.session, member.member.spec.limits.maxJournalConflicts, this.clock).append(workExecutionReleasedEvent,
            () => ({ assignment: accepted.work!.assignment, accepted: accepted.reference.eventId, root: root.id,
              owner: this.owner, generation: member.executions!.generation, outcome }))
          if (outcome === 'unknown') throw failure
        }
      }
      const publication = nextWorkPublication(member.session, this.clock)
      if (publication !== undefined) return publication
      const proposal = [...state.proposals, ...state.reviews].find(item => item.payload.message.assignment.eventId === work.stored.eventId)
      const decisionMissing = !state.decisions.some(item => item.payload.assignment.eventId === work.stored.eventId)
      const evaluated = resolveWorkflowReviews(state, work.stored.eventId)
      if (proposal !== undefined && decisionMissing && (evaluated !== undefined || proposal.payload.message.value.outcome !== 'completed')) return () => entry.journal.append(workflowDecisionCommittedEvent, () => ({
        definition: definition.stored.eventId, assignment: proposal.payload.message.assignment, proposal: proposal.payload.message.proposal,
        expectedOutputRevision: 0 as const, outcome: proposal.payload.message.value.outcome === 'completed' ? evaluated!.outcome : 'rejected' as const, value: proposal.payload.message.value.value,
        artifacts: proposal.payload.message.value.artifacts, reviews: proposal.payload.message.value.outcome === 'completed' ? evaluated!.reviews : [],
      }))
      if (proposal !== undefined && decisionMissing && state.desired === 'running' && work.payload.kind === 'production' && work.payload.acceptance.kind === 'reviewed-all'
        && state.assignments.filter(item => !state.decisions.some(decision => decision.payload.assignment.eventId === item.stored.eventId)).length < definition.payload.limits.maxActiveAssignments) {
        for (const reviewer of work.payload.acceptance.reviewers) {
          if (state.assignments.some(item => item.payload.kind === 'review' && item.payload.reviewOf.assignment.eventId === work.stored.eventId && item.payload.memberKey === reviewer)) continue
          const peer = this.slots.find(slot => slot.member.agentKey === reviewer)
          if (peer === undefined || !workflowMemberIdle(peer) || !this.businessAllowed(peer)) continue
          return async () => {
            const authority = assertWorkflowParticipant(definition.payload, peer, reviewer)
            const actions = work.payload.reviewerReservations.find(item => item.memberKey === reviewer)!.grant.waits > 0
              && authority.nativeActions.includes('agent_ask_user') ? ['agent_ask_user'] : []
            await peer.executions!.release()
            try {
              const assigned = await entry.admission.admitReview(work.stored.eventId, peer.session, parseChannelId(randomUUID()),
                () => { assertWorkflowParticipant(definition.payload, peer, reviewer) }, actions)
              this.communication.workflowChannels.bind(coordinator.session, assigned.stored.eventId, peer.session)
            } catch (cause) {
              if (coordinator.session.status === 'open' && !(cause instanceof WorkflowError && cause.code === 'WORKFLOW_COMMIT_UNKNOWN')) {
                this.slots[this.slots.indexOf(peer)] = await peer.executions!.replace({ kind: 'ordinary' }, {})
              }
              throw cause
            }
          }
        }
      }
      if (workflowAssignmentClosed(coordinator.session, member.session, work.stored.eventId, this.slots.map(slot => slot.session))) return async () => {
        entry.admission.retire(work.stored.eventId, member.session, this.slots.map(slot => slot.session))
        this.#retired.add(work.stored.eventId)
        this.#workspaces.delete(work.stored.eventId)
        const replacement = await member.executions!.replace({ kind: 'ordinary' }, {})
        this.slots[this.slots.indexOf(member)] = replacement
      }
    }
    if (state.desired !== 'running') return undefined
    for (const node of definition.payload.nodes) {
      if (state.assignments.some(item => item.payload.nodeKey === node.nodeKey) || state.resolved.some(item => item.nodeKey === node.nodeKey)) continue
      const resolution = resolveWorkflowNode(node, new Map(state.upstream.map(item => [item.nodeKey, item.state])),  definition.payload)
      if (resolution.kind === 'skipped' || resolution.kind === 'failed') return () => entry.journal.append(workflowNodeResolvedEvent,
        () => ({ definition: definition.stored.eventId, nodeKey: node.nodeKey, outcome: resolution.kind as 'skipped' | 'failed', reason: resolution.reason }))
      if (resolution.kind !== 'ready') continue
      const member = this.slots.find(slot => slot.member.agentKey === node.executor)
      if (member === undefined || !workflowMemberIdle(member) || !this.businessAllowed(member)) continue
      return async () => {
        assertWorkflowMember(definition.payload, member, node.nodeKey)
        await member.executions!.release()
        let lease: WorkspaceLease | undefined
        try {
          lease = await prepareWorkWorkspace(member.member, node.attempts[0]!, this.workspaceAuthority)
          const assignment = await entry.admission.admitRoot(node.nodeKey, member.session, parseChannelId(randomUUID()),
            () => assertWorkflowMember(definition.payload, member, node.nodeKey), await lease?.baseline() ?? null)
          if (lease !== undefined) this.#workspaces.set(assignment.stored.eventId, lease)
          this.communication.workflowChannels.bind(coordinator.session, assignment.stored.eventId, member.session)
        } catch (cause) {
          if (coordinator.session.status === 'open' && !(cause instanceof WorkflowError && cause.code === 'WORKFLOW_COMMIT_UNKNOWN')) {
            await lease?.dispose()
            this.slots[this.slots.indexOf(member)] = await member.executions!.replace({ kind: 'ordinary' }, {})
          }
          throw cause
        }
      }
    }
    return undefined
  }

  closeAdmission(): void { this.#closed = true; for (const entry of this.#entries.values()) entry.admission.closeAdmission() }
  async dispose(): Promise<void> { this.closeAdmission(); await this.#gate.drain() }
  #entry(key: string): WorkflowEntry {
    const entry = this.#entries.get(key)
    if (entry === undefined) throw new HostError('HOST_NOT_READY', 'workflow-not-configured')
    return entry
  }
}

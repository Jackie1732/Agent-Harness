import { reviewAssignment } from './review.js'
import type { WorkflowSnapshot } from './projection.js'
import { assertWorkflowMessageFits } from './message-budget.js'
import { workflowSourceCommands } from './protocol.js'
import { workflowAssignmentClosed } from './closure.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { Clock } from '../foundation/clock.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonObject } from '../foundation/json.js'
import { ProtocolCapacity } from '../communication/protocol-capacity.js'
import type { MailboxDirection } from '../communication/protocol-capacity.js'
import type { MailboxReservation } from '../communication/protocol-capacity.js'
import type { MessageEnvelope } from '../communication/types.js'
import { encodeStoredSessionEvent } from '../session/codec.js'
import { SessionError } from '../session/errors.js'
import { extendLocalSegment } from '../session/history.js'
import { formatSessionEventId, sessionLogPosition, sessionSequence } from '../session/ids.js'
import type { ChannelId } from '../communication/ids.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent, SessionSnapshot, StoredSessionEvent } from '../session/types.js'
import { SESSION_ENVELOPE_VERSION } from '../session/types.js'
import { WorkflowError } from './errors.js'
import { resolveWorkflowNode } from './graph.js'
import { projectWorkflowSession } from './projection.js'
import { workflowAssignmentMailboxDemand } from './protocol-capacity.js'
import { nextWorkflowAttempt } from './retry.js'
import { workflowAssignmentCommittedEvent } from './session-events.js'
import type { WorkflowAssignment } from './types.js'

const blocked = (reason: string): never => { throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', reason) }

function payloadRef(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const reference = value as Record<string, unknown>
  return typeof reference.eventId === 'string' ? reference.eventId : undefined
}

/** Map one Workflow envelope to its sender or recipient Assignment reservation. */
function belongs(event: CommittedSessionEvent<WorkflowAssignment & JsonObject>, envelope: MessageEnvelope,
  address: string, direction: MailboxDirection): boolean {
  if (!envelope.type.startsWith('workflow/') || envelope.payloadVersion !== 1) return false
  const body = envelope.payload
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
  const payload = body as JsonObject
  const source = payloadRef(payload.assignment)
  const target = payloadRef(payload.targetAssignment)
  if (target === undefined && envelope.channelId !== event.payload.channelId) return false
  const id = event.stored.eventId
  if (direction === 'outbox') return envelope.sender === address && source === id
  return envelope.recipient === address && (target ?? source) === id
}

/** Owns conditional CP-W admission and its shared mailbox reservation. */
export class WorkflowAdmission {
  readonly #leases = new Map<SessionEventId, object>()
  #closed = false
  #uncertain = false

  constructor(readonly coordinator: SessionHandle, readonly capacity: ProtocolCapacity, readonly clock: Clock) {}

  retire(assignment: SessionEventId, member: SessionHandle, peers: readonly SessionHandle[] = []): void {
    if (!workflowAssignmentClosed(this.coordinator, member, assignment, peers)) blocked('assignment-still-open')
    const lease = this.#leases.get(assignment)
    if (lease !== undefined) { this.capacity.retire(lease); this.#leases.delete(assignment) }
  }

  closeAdmission(): void { this.#closed = true }

  /** Restore committed reservations before mailboxes admit ordinary traffic. */
  restore(event: CommittedSessionEvent<WorkflowAssignment & JsonObject>, member: SessionHandle): Promise<void> {
    return this.capacity.run(async () => {
      if (this.#closed || this.#uncertain) blocked('admission-closed')
      if (this.#leases.has(event.stored.eventId)) return
      const saved = projectWorkflowSession(this.coordinator.snapshot()).assignments.find(item => item.stored.eventId === event.stored.eventId)
      if (saved === undefined || member.header.address !== event.payload.memberAddress) blocked('assignment-source')
      const quotas = this.#quotas(event.payload)
      this.capacity.check(quotas, new Map([[this.coordinator.header.address, this.coordinator], [member.header.address, member]]),
        (envelope, address, direction) => belongs(event, envelope, address, direction))
      this.#install(event, quotas)
    })
  }

  /** Commit one initially ready production assignment after the caller's Host admission gate checks current policy. */
  async admitRoot(nodeKey: string, member: SessionHandle, channelId: ChannelId,
    authorize: () => void, baseline: WorkflowAssignment['workspaceBaseline'] = null): Promise<CommittedSessionEvent<WorkflowAssignment & JsonObject>> {
    authorize()
    return this.#commit(member, (state, observedAt) => {
      const definition = state.definition!
      const node = definition.payload.nodes.find(item => item.nodeKey === nodeKey)
      if (node === undefined || !state.ready.includes(nodeKey)) throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', 'node-not-ready')
      const number = nextWorkflowAttempt(state, nodeKey)!
      const attempt = node.attempts[number - 1]!
      if (attempt.workspace.kind !== 'none' && baseline === null) blocked('workspace-lease-required')
      const memberRecord = definition.payload.roster.find(item => item.memberKey === node.executor)
      if (memberRecord?.address !== member.header.address) blocked('member-not-bound')
      const selected = resolveWorkflowNode(node, new Map(state.upstream.map(item => [item.nodeKey, item.state])),  definition.payload)
      if (selected.kind !== 'ready') throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', 'node-not-ready')
      const deadlineMs = Math.min(Date.parse(definition.payload.deadline), Date.parse(observedAt) + attempt.durationMs)
      if (deadlineMs <= Date.parse(observedAt)) blocked('workflow-deadline')
      return workflowAssignmentCommittedEvent.decode(snapshotJson({
        definition: definition.stored.eventId, nodeKey, attempt: number, kind: 'production',
        memberKey: node.executor, memberAddress: member.header.address, channelId,
        inputs: selected.inputs, sourceAccepted: state.decisions.filter(item => item.payload.outcome === 'accepted' && node.inputs.some(input => input.source.kind === 'accepted'
          && state.assignments.find(assignment => assignment.payload.kind === 'production' && assignment.stored.eventId === item.payload.assignment.eventId)?.payload.nodeKey === input.source.nodeKey))
          .map(item => ({ address: definition.payload.coordinator, eventId: item.stored.eventId })), effectiveAllowance: attempt.workerGrant,
        reviewerReservations: attempt.reviewerGrants, toolNames: attempt.toolNames,
        nativeActions: attempt.nativeActions, workspace: attempt.workspace, workspaceBaseline: baseline,
        protocolLimits: { maxMessageBytes: this.capacity.limits.maxMessageBytes, maxRecordBytes: Math.min(this.coordinator.maxRecordBytes, member.maxRecordBytes) },
        protocolReserve: workflowAssignmentMailboxDemand(definition.payload, 'production'),
        deadline: new Date(deadlineMs).toISOString(), acceptance: node.acceptance,
      }))
    })
  }

  admitReview(production: SessionEventId, member: SessionHandle, channelId: ChannelId, authorize: () => void,
    nativeActions: readonly string[] = []): Promise<CommittedSessionEvent<WorkflowAssignment & JsonObject>> {
    authorize()
    return this.#commit(member, (state, observedAt) => workflowAssignmentCommittedEvent.decode(snapshotJson(reviewAssignment(state, production, member.header.address, channelId,
      observedAt, { maxMessageBytes: this.capacity.limits.maxMessageBytes, maxRecordBytes: Math.min(this.coordinator.maxRecordBytes, member.maxRecordBytes) }, nativeActions))))
  }

  #commit(member: SessionHandle, derive: (state: WorkflowSnapshot, observedAt: string) => WorkflowAssignment & JsonObject): Promise<CommittedSessionEvent<WorkflowAssignment & JsonObject>> {
    return this.capacity.run(async () => {
      for (let conflict = 0; ; conflict++) {
        if (this.#closed || this.#uncertain || this.coordinator.status !== 'open' || member.status !== 'open') blocked('admission-closed')
        const snapshot = this.coordinator.snapshot()
        const state = projectWorkflowSession(snapshot)
        const definition = state.definition
        if (definition === null) throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', 'definition-missing')
        const observedAt = clockTimestamp(this.clock)
        const candidate = derive(state, observedAt)
        this.#preview(snapshot, candidate, observedAt, member.maxRecordBytes)
        const quotas = this.#quotas(candidate)
        this.capacity.check(quotas, new Map([[this.coordinator.header.address, this.coordinator], [member.header.address, member]]))
        try {
          const saved = await this.coordinator.appendIfPosition(snapshot.localPosition, workflowAssignmentCommittedEvent, candidate)
          this.#install(saved, quotas)
          return saved
        } catch (cause) {
          if (cause instanceof SessionError && cause.code === 'SESSION_PRECONDITION_FAILED'
            && conflict < definition.payload.limits.maxCommitConflicts) continue
          if (cause instanceof SessionError && cause.code === 'SESSION_APPEND_OUTCOME_UNKNOWN') {
            this.#uncertain = true
            throw new WorkflowError('WORKFLOW_COMMIT_UNKNOWN', 'assignment-commit-unknown')
          }
          throw cause
        }
      }
    })
  }

  #preview(snapshot: SessionSnapshot, payload: WorkflowAssignment & JsonObject, recordedAt: string, memberRecordBytes: number): void {
    const sequence = sessionSequence(snapshot.localPosition + 1)
    const stored: StoredSessionEvent = { envelopeVersion: SESSION_ENVELOPE_VERSION, sessionId: snapshot.header.sessionId,
      eventId: formatSessionEventId(snapshot.header.sessionId, sequence), sequence, recordedAt,
      type: workflowAssignmentCommittedEvent.type, payloadVersion: 1, payload }
    if (encodeStoredSessionEvent(stored).byteLength > this.coordinator.maxRecordBytes) blocked('assignment-record-size')
    const event: CommittedSessionEvent<WorkflowAssignment & JsonObject> = { kind: 'known', stored, payload }
    const sources = new Map(snapshot.history.at(-1)!.events.filter(item => item.kind === 'known').map(item => [item.stored.eventId, item]))
    sources.set(event.stored.eventId, event)
    for (const command of workflowSourceCommands(sources, event.stored.eventId).commands) {
      const limits = { maxMessageBytes: this.capacity.limits.maxMessageBytes, maxRecordBytes: Math.min(this.coordinator.maxRecordBytes, memberRecordBytes) }
      assertWorkflowMessageFits(snapshot.header.sessionId, command, limits)
      assertWorkflowMessageFits(snapshot.header.sessionId, { ...command, type: 'workflow/stop', payload: {
        assignment: { address: snapshot.header.address, eventId: event.stored.eventId },
        stop: { address: snapshot.header.address, eventId: formatSessionEventId(snapshot.header.sessionId, sessionSequence(Number.MAX_SAFE_INTEGER)) }, binding: command.payload,
      } }, limits)
    }
    const history = snapshot.history.map(segment => segment.header.sessionId === snapshot.header.sessionId
      ? extendLocalSegment(segment, event) : segment)
    try { projectWorkflowSession({ ...snapshot, localPosition: sessionLogPosition(sequence), history }) }
    catch (cause) {
      if (cause instanceof WorkflowError && cause.code === 'WORKFLOW_HISTORY_INVALID') blocked(cause.message)
      throw cause
    }
  }

  #quotas(payload: WorkflowAssignment) {
    return new Map([[this.coordinator.header.address, payload.protocolReserve.coordinator],
      [payload.memberAddress, payload.protocolReserve.member]])
  }
  #install(event: CommittedSessionEvent<WorkflowAssignment & JsonObject>, quotas: ReadonlyMap<string, MailboxReservation>): void {
    const token = Object.freeze({})
    this.capacity.install(token, quotas, (envelope, address, direction) => belongs(event, envelope, address, direction))
    this.#leases.set(event.stored.eventId, token)
  }
}

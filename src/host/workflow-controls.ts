import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { SerialGate } from '../foundation/serial-gate.js'
import type { SessionEventId } from '../session/ids.js'
import { projectAgentSession } from '../agent/projection.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { workflowControlRequestedEvent, workflowControlSettledEvent } from '../workflow/control-events.js'
import type { WorkflowRetryRequest } from '../workflow/control-events.js'
import type { WorkflowJournal } from '../workflow/journal.js'
import { retryRequestFailure } from '../workflow/retry.js'
import { sameWorkflowValue } from '../workflow/work-binding.js'
import { workflowAssignmentClosed } from '../workflow/closure.js'
import { assignmentMember } from './workflow-authority.js'
import { notifyWorkflowStop } from './workflow-stop.js'
import type { NotifyWorkStop } from './workflow-stop.js'
import type { HostSlot, HostProtocolSlot } from './runtime-types.js'
import { HostError } from './errors.js'

interface WorkflowEntry { readonly slot: HostProtocolSlot; readonly journal: WorkflowJournal }
export interface WorkflowChildren {
  readonly notify: NotifyWorkStop
  cancel(memberKey: string, root: SessionEventId): Promise<void>
  resume(memberKey: string, root: SessionEventId): void
}
interface WorkflowControlOptions {
  readonly entries: ReadonlyMap<string, WorkflowEntry>
  readonly slots: HostSlot[]
  readonly gate: SerialGate
  readonly clock: Clock
  readonly owner: string
  readonly retired: ReadonlySet<string>
  readonly children: WorkflowChildren
}

/** Operator requests own runtime resumption and durable control identity under the shared admission gate. */
export class HostWorkflowControls {
  readonly #active = new Set<string>()
  readonly #stopping = new Set<string>()
  #closed = false
  constructor(readonly options: WorkflowControlOptions) {}
  get closed(): boolean { return this.#closed }
  active(key: string): boolean { return this.#active.has(key) }
  stopping(key: string): boolean { return this.#stopping.has(key) }
  closeAdmission(): void { this.#closed = true }

  request(key: string, kind: 'pause' | 'resume' | 'cancel', input: { readonly requestKey: string; readonly reason?: string }) {
    return this.options.gate.run(() => {
      if (this.#closed) throw new HostError('HOST_INACTIVE', 'workflow-host-closed')
      return this.#applyControl(key, this.#entry(key), kind, input)
    })
  }

  async #applyControl(key: string, entry: WorkflowEntry, kind: 'pause' | 'resume' | 'cancel', input: { readonly requestKey: string; readonly reason?: string }) {
    const state = projectWorkflowSession(entry.slot.session.snapshot())
    const payload = workflowControlRequestedEvent.decode({ definition: state.definition!.stored.eventId, kind,
      requestKey: input.requestKey, reason: input.reason ?? '' })
    const prior = state.controls.find(item => item.requested.payload.requestKey === input.requestKey)
    if (prior !== undefined && !sameWorkflowValue(prior.requested.payload, payload)) throw new HostError('HOST_BINDING_CONFLICT', 'workflow-request-key-conflict')
    if (kind === 'cancel' && state.terminal === null) {
      this.#stopping.add(key)
      notifyWorkflowStop(entry.slot, this.options.slots, this.options.children.notify)
    }
    const requested = prior?.requested ?? await entry.journal.append(workflowControlRequestedEvent, () => payload)
    const stopped = state.stop !== null || state.terminal !== null || state.controls.some(item => item.requested.payload.kind === 'cancel' && item.settled?.payload.outcome !== 'no-op')
    const settled = prior?.settled ?? await entry.journal.append(workflowControlSettledEvent, () => ({ request: requested.stored.eventId, outcome: stopped ? 'no-op' as const : 'applied' as const, owner: this.options.owner }))
    const latest = projectWorkflowSession(entry.slot.session.snapshot()).controls.at(-1)
    if (latest?.requested.stored.eventId === requested.stored.eventId && kind === 'resume' && settled.payload.outcome === 'applied') {
      for (const work of state.assignments) {
        const member = assignmentMember(this.options.slots, work.payload)
        const root = projectAgentSession(member.session.snapshot()).roots.find(root => root.source.kind === 'workflow' && root.source.assignment.eventId === work.stored.eventId)
        if (root !== undefined) this.options.children.resume(member.member.agentKey, root.id)
      }
      this.#active.add(key)
    }
    return { status: settled.payload.outcome === 'no-op' ? 'no-op' as const : kind === 'resume' && latest?.requested.stored.eventId === requested.stored.eventId ? 'resumed' as const : 'applied' as const,
      ref: { address: entry.slot.session.header.address, eventId: settled.stored.eventId } }
  }

  /** Host shutdown persists stops for owned roots while leaving transport settlement to protocol maintenance. */
  cancelOwned(): Promise<void> {
    for (const [key, entry] of this.options.entries) {
      this.#stopping.add(key)
      notifyWorkflowStop(entry.slot, this.options.slots, this.options.children.notify)
    }
    return this.options.gate.run(async () => {
      const results = await Promise.allSettled([...this.options.entries].map(async ([key, entry]) => {
        const state = projectWorkflowSession(entry.slot.session.snapshot())
        if (state.terminal === null && (state.assignments.length > 0 || this.#active.has(key))) {
          await this.#applyControl(key, entry, 'cancel', { requestKey: 'host-shutdown:' + this.options.owner, reason: 'host-cancelled' })
        }
        for (const work of state.assignments) {
          const member = assignmentMember(this.options.slots, work.payload)
          const root = projectAgentSession(member.session.snapshot()).roots.find(root => root.source.kind === 'workflow' && root.source.assignment.eventId === work.stored.eventId)
          if (root === undefined) continue
          const stopped = await Promise.allSettled([this.options.children.cancel(member.member.agentKey, root.id),
            ...(root.outcome === null ? [member.agent.cancel(root.id, 'host-cancelled-workflow')] : [])])
          const failures = stopped.filter(item => item.status === 'rejected').map(item => item.reason)
          if (failures.length > 0) throw new AggregateError(failures, 'workflow-root-stop-incomplete')
        }
      }))
      const failures = results.filter(item => item.status === 'rejected').map(item => item.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'workflow-shutdown-stop-incomplete')
    })
  }

  retry(key: string, input: WorkflowRetryRequest) {
    return this.options.gate.run(async () => {
      if (this.#closed) throw new HostError('HOST_INACTIVE', 'workflow-host-closed')
      const entry = this.#entry(key), state = projectWorkflowSession(entry.slot.session.snapshot())
      const payload = workflowControlRequestedEvent.decode({ definition: state.definition!.stored.eventId, kind: 'retry', ...input })
      const prior = state.controls.find(item => item.requested.payload.requestKey === input.requestKey)
      if (prior !== undefined && !sameWorkflowValue(prior.requested.payload, payload)) throw new HostError('HOST_BINDING_CONFLICT', 'workflow-request-key-conflict')
      if (prior === undefined) {
        const reason = retryRequestFailure(state, input, clockTimestamp(this.options.clock))
        if (this.#stopping.has(key) || reason !== undefined) throw new HostError('HOST_NOT_READY', reason ?? 'workflow-stopping')
        const previous = state.assignments.filter(item => item.stored.eventId === input.failedAssignment.eventId
          || item.payload.kind === 'review' && item.payload.reviewOf.assignment.eventId === input.failedAssignment.eventId)
        if (previous.some(item => !this.options.retired.has(item.stored.eventId) || !workflowAssignmentClosed(entry.slot.session,
          assignmentMember(this.options.slots, item.payload).session, item.stored.eventId, this.options.slots.map(slot => slot.session)))) throw new HostError('HOST_NOT_READY', 'workflow-retry-still-closing')
      }
      const requested = prior?.requested ?? await entry.journal.append(workflowControlRequestedEvent, () => payload)
      const settled = prior?.settled ?? await entry.journal.append(workflowControlSettledEvent, () => ({ request: requested.stored.eventId,
        outcome: state.stop !== null || state.terminal !== null ? 'no-op' as const : 'applied' as const, owner: this.options.owner }))
      return { status: settled.payload.outcome, ref: { address: entry.slot.session.header.address, eventId: settled.stored.eventId } }
    })
  }

  #entry(key: string): WorkflowEntry {
    const entry = this.options.entries.get(key)
    if (entry === undefined) throw new HostError('HOST_NOT_READY', 'workflow-not-configured')
    return entry
  }
}

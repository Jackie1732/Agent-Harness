import { delegationReport } from '../subagent/report.js'
import { agentStopAction } from '../agent/stop-maintenance.js'
import { effectiveResourceRelease } from '../subagent/resource-evidence.js'
import type { DiscoveredDelegation } from './delegation-discovery.js'
import type { ResolvedHostLocalMember } from './config.js'
import { equal, text } from '../agent/validation.js'
import type { WorkspaceAuthority } from '../subagent/workspace.js'
import { EffectOwner } from '../effect/owner.js'
import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionRepository } from '../session/repository.js'
import type { SessionHandle } from '../session/session-handle.js'
import { projectAgentSession } from '../agent/projection.js'
import { agentControlRequestedEvent } from '../agent/session-events.js'
import { AgentError } from '../agent/errors.js'
import type { CommunicationService } from '../communication/service.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import { SubagentAdmission } from '../subagent/admission.js'
import type { AcceptedDelegation } from '../subagent/admission.js'
import { SessionSubagentActions } from '../subagent/actions.js'
import { classificationAction, taskProtocolAction, resultProtocolAction, protocolSendAction } from '../subagent/protocol-maintenance.js'
import type { ProtocolAction } from '../subagent/protocol-maintenance.js'
import { childSettlementObservation, observationChanged } from '../subagent/observation.js'
import { delegationClosure, protocolSettled } from '../subagent/closure.js'
import * as events from '../subagent/session-events.js'
import type { HostSubagentConfig } from './subagent-config.js'
import type { HostSlot, HostProtocolSlot } from './runtime-types.js'
import type { HostRuntimeBindings } from './slot.js'
import { protocolFailureAction } from '../subagent/protocol-failure.js'
import { ChildInstance } from './child-instance.js'
import { HostError } from './errors.js'
import { SubagentError } from '../subagent/errors.js'
import { isModelAdmissionPending } from './model-admission.js'

export interface HostSubagentOptions {
  readonly config: Extract<HostSubagentConfig, { kind: 'enabled' }>
  readonly repository: SessionRepository
  readonly communication: CommunicationService
  readonly catalog: MessageCatalog
  readonly clock: Clock
  readonly credentials: Readonly<Record<string, string>>
  readonly protectedRoots: readonly string[]
  readonly bindings: HostRuntimeBindings
  readonly slots: HostSlot[]
  readonly localMembers: readonly { member: ResolvedHostLocalMember; session: SessionHandle }[]
  readonly protocolSlots: HostProtocolSlot[]
  readonly childAddresses: Set<string>
  readonly workspaces: WorkspaceAuthority
}

/** Domain maintenance is selected by the existing Host scheduler, with no private business loop. */
export class HostSubagents {
  readonly admission: SubagentAdmission
  readonly #children = new Map<SessionEventId, ChildInstance>()
  readonly #lifetimes = new EffectOwner('Host children')
  readonly #failed = new Set<SessionEventId>()
  readonly #blocked = new Map<SessionEventId, string>()
  readonly #suspended = new Map<SessionEventId, SessionHandle | null>()
  readonly #retired = new Set<SessionEventId>()
  readonly #offlineParents = new Set<string>()
  readonly #maintenance = new Map<SessionEventId, Promise<void>>()
  #cursor = 0
  #closing = false
  #dispose: Promise<void> | undefined
  constructor(readonly options: HostSubagentOptions) {
    this.admission = new SubagentAdmission(options.config, options.communication, options.clock, options.workspaces)
  }
  get suspendedParents(): readonly string[] { return [...new Set(this.admission.accepted.filter(item => this.#suspended.has(item.event.stored.eventId)).map(item => item.parentKey))] }
  async restore(discovered: readonly DiscoveredDelegation[], local: readonly { member: ResolvedHostLocalMember; session: SessionHandle }[]): Promise<void> {
    for (const item of discovered.filter(item => !item.closed)) {
      const parent = local.find(entry => entry.member.agentKey === item.parentKey)!.session
      const template = this.options.config.templates.find(template => template.templateKey === item.requested.payload.request.templateKey && template.templateVersion === item.requested.payload.request.templateVersion)
      if (template === undefined || !equal(template, item.requested.payload.effectivePlan.template)) throw new HostError('HOST_BINDING_CONFLICT', 'delegation-template-changed')
      if (item.child !== null) {
        const child = projectAgentSession(item.child)
        if (child.openRun !== null || child.openTurn !== null || child.openRecovery !== null || child.subagents.resources.some(resource => effectiveResourceRelease(resource, child.subagents.recoveries)?.outcome !== 'released')
          || child.subagents.recoveries.some(recovery => recovery.settled === null && recovery.supersededBy === null)) throw new HostError('HOST_RECOVERY_REQUIRED', 'delegation-predecessor-not-reconciled')
      }
      await this.admission.restore(item.parentKey, parent, item.requested)
      this.#suspended.set(item.requested.stored.eventId, item.child === null ? null : await this.options.repository.open(item.child.header.sessionId))
    }
  }
  resume(parentKey: string) {
    this.#offlineParents.delete(parentKey); this.admission.resumeParent(parentKey)
    const result: { delegationId: SessionEventId; status: 'resumed' | 'blocked'; reasonCode: string }[] = []
    for (const accepted of this.admission.accepted.filter(item => item.parentKey === parentKey && this.#suspended.has(item.event.stored.eventId))) {
      const session = this.#suspended.get(accepted.event.stored.eventId)!
      const state = session === null ? null : projectAgentSession(session.snapshot())
      const pending = state !== null && (state.openRun !== null || state.openRecovery !== null || state.subagents.resources.some(item => effectiveResourceRelease(item, state.subagents.recoveries)?.outcome !== 'released'))
      if (pending) { result.push({ delegationId: accepted.event.stored.eventId, status: 'blocked', reasonCode: 'recovery-required' }); continue }
      try {
        const parent = projectAgentSession(accepted.parent.snapshot())
        const root = parent.roots.find(item => item.id === accepted.event.payload.parentRoot)!
        const business = state?.roots[0]?.outcome == null && root.outcome === null && root.stopControl === null
          && !parent.subagents.controls.some(item => item.requested.payload.delegation === accepted.event.stored.eventId)
          && this.options.clock.now() < Date.parse(accepted.event.payload.deadline)
        this.admission.authorizeResume(accepted, business)
        this.#suspended.delete(accepted.event.stored.eventId)
        this.#restored.set(accepted.event.stored.eventId, session)
        result.push({ delegationId: accepted.event.stored.eventId, status: 'resumed', reasonCode: 'explicit-resume' })
      } catch (cause) {
        if (!(cause instanceof SubagentError)) throw cause
        result.push({ delegationId: accepted.event.stored.eventId, status: 'blocked', reasonCode: 'current-authority-or-capacity' })
      }
    }
    return result
  }
  readonly #restored = new Map<SessionEventId, SessionHandle | null>()
  actions(parentKey: string, session: SessionHandle) { return new SessionSubagentActions(session, parentKey, this.admission, this.options.clock) }
  closeAdmission(): void { this.#closing = true; this.admission.closeAdmission() }

  /** Removing a parent closes new admissions before waiting for its current child acquisitions. */
  stopParent(parentKey: string): void {
    this.#offlineParents.add(parentKey); this.admission.pauseParent(parentKey)
    for (const item of this.admission.accepted.filter(item => item.parentKey === parentKey)) this.notifyParentStop(parentKey, item.event.payload.parentRoot)
  }
  async releaseParent(parentKey: string): Promise<void> {
    await this.admission.drain()
    const entries = this.admission.accepted.filter(item => item.parentKey === parentKey && !this.#retired.has(item.event.stored.eventId))
    const maintenance = await Promise.allSettled(entries.map(item => this.#maintenance.get(item.event.stored.eventId)))
    const results = await Promise.allSettled(entries.map(async item => {
      const id = item.event.stored.eventId
      await this.cancel(parentKey, item.event.payload.parentRoot, id, 'parent-mailbox-offline:' + id)
      const child = this.#children.get(id)
      await child?.dispose()
      const state = projectAgentSession(item.parent.snapshot())
      for (const resource of state.subagents.resources.filter(resource => resource.opened.payload.delegation === id && effectiveResourceRelease(resource, state.subagents.recoveries) === null)) {
        await item.journal.append(events.subagentReleaseRecordedEvent, () => ({ delegation: id, parentAddress: item.event.payload.parentAddress, childAddress: item.event.payload.childAddress,
          opened: resource.opened.stored.eventId, component: 'protocol' as const, outcome: 'released' as const, reasonCode: 'parent-mailbox-stopped' }))
      }
      this.#children.delete(id); this.#suspended.set(id, child?.session ?? null)
    }))
    const failures = [...maintenance, ...results].filter(item => item.status === 'rejected').map(item => item.reason)
    if (failures.length > 0) throw new HostError('HOST_CLEANUP_FAILED', 'parent-child-release-incomplete', {}, { cause: new AggregateError(failures) })
  }

  /** Abort notification does not wait for the parent's or child's next journal acknowledgement. */
  notifyParentStop(parentKey: string, root: SessionEventId): void {
    for (const accepted of this.admission.accepted.filter(item => item.parentKey === parentKey && item.event.payload.parentRoot === root && !this.#retired.has(item.event.stored.eventId))) {
      this.options.communication.delegationChannels.revoke(accepted.lease)
      const child = this.#children.get(accepted.event.stored.eventId)
      const childRoot = child?.slot?.agent.snapshot().roots[0]
      if (childRoot !== undefined) child?.slot?.agent.notifyStop(childRoot.id)
    }
  }

  /** Select at most one bounded transition; round-robin persists across scheduler batches. */
  nextAction(): ProtocolAction | undefined {
    if (this.#closing) return undefined
    const entries = this.admission.accepted
    for (let offset = 0; offset < entries.length; offset++) {
      const index = (this.#cursor + offset) % entries.length
      const accepted = entries[index]!
      if (this.#offlineParents.has(accepted.parentKey) || this.#suspended.has(accepted.event.stored.eventId) || this.#blocked.has(accepted.event.stored.eventId) || this.#retired.has(accepted.event.stored.eventId)) continue
      const action = this.#action(accepted)
      if (action !== undefined) return async () => {
        this.#cursor = (index + 1) % entries.length
        const task = Promise.resolve().then(action).then(() => undefined)
        this.#maintenance.set(accepted.event.stored.eventId, task)
        try { await task }
        catch (cause) {
          // A rejected conditional append owns no commit. Yield to the bounded scheduler and select again from fresh facts.
          if (!accepted.journal.faulted && cause instanceof AgentError && cause.code === 'AGENT_JOURNAL_CONFLICT') return
          const code = cause instanceof AgentError || cause instanceof SubagentError || cause instanceof HostError ? cause.code : 'SUBAGENT_MAINTENANCE_FAILED'
          if (accepted.journal.faulted || cause instanceof AgentError && ['AGENT_COMMIT_UNKNOWN', 'AGENT_WRITE_FAILED'].includes(cause.code)) {
            this.#blocked.set(accepted.event.stored.eventId, code); this.admission.closeAdmission()
          } else if (!projectAgentSession(accepted.parent.snapshot()).subagents.provisions.some(item => item.payload.delegation === accepted.event.stored.eventId)) {
            this.#failed.add(accepted.event.stored.eventId)
          } else { this.#blocked.set(accepted.event.stored.eventId, code); this.admission.closeAdmission() }
        } finally { this.#maintenance.delete(accepted.event.stored.eventId) }
      }
    }
    return undefined
  }

  inspect(parentKey: string, root: SessionEventId, id: SessionEventId) {
    const entry = this.report(Number.MAX_SAFE_INTEGER).delegations.find(item => item.parentKey === parentKey && item.parentRoot === root && item.delegationId === id)
    if (entry === undefined) throw new HostError('HOST_NOT_READY', 'delegation-not-owned')
    return entry
  }
  async cancel(parentKey: string, root: SessionEventId, id: SessionEventId, requestKey: string) {
    text(requestKey, 128)
    const entry = this.inspect(parentKey, root, id)
    const parent = this.options.localMembers.find(item => item.member.agentKey === parentKey)!.session
    const previous = () => projectAgentSession(parent.snapshot()).subagents.controls.find(item =>
      item.requested.payload.delegation === id && item.requested.payload.source.kind === 'controller'
      && item.requested.payload.source.requestKey === requestKey)
    const receipt = () => {
      const prior = previous()
      if (prior === undefined) return undefined
      if (prior.requested.payload.kind !== 'cancel' || prior.requested.payload.reasonCode !== 'caller-cancelled-delegation') {
        throw new SubagentError('SUBAGENT_REQUEST_CONFLICT', 'control-key-content-conflict')
      }
      return { eventId: prior.requested.stored.eventId }
    }
    const prior = receipt()
    if (prior !== undefined) return prior
    if (entry.closed) return { kind: 'already-closed' as const }
    const accepted = this.admission.accepted.find(item => item.event.stored.eventId === id)!
    this.notifyParentStop(parentKey, root)
    try {
      const event = await accepted.journal.append(events.subagentControlRequestedV2Event, () => ({ delegation: id,
        parentAddress: accepted.event.payload.parentAddress, childAddress: accepted.event.payload.childAddress, kind: 'cancel' as const,
        source: { kind: 'controller' as const, requestKey }, reasonCode: 'caller-cancelled-delegation', observedAt: clockTimestamp(this.options.clock) }))
      return { eventId: event.stored.eventId }
    } catch (cause) {
      // A concurrent identical request may commit before this conditional append's preflight.
      const committed = accepted.journal.faulted ? undefined : receipt()
      if (committed !== undefined) return committed
      throw cause
    }
  }
  report(limit: number) {
    const parents = this.options.localMembers
      .map(item => ({ parentKey: item.member.agentKey, snapshot: item.session.snapshot() }))
    return delegationReport(parents, limit, id => ({ suspended: this.#suspended.has(id), recoveryRequired: this.#blocked.has(id), failed: this.#failed.has(id), failureCode: this.#blocked.get(id) ?? null }))
  }

  #action(accepted: AcceptedDelegation): ProtocolAction | undefined {
    const id = accepted.event.stored.eventId
    const parent = this.options.slots.find(slot => slot.session === accepted.parent)
    if (parent === undefined || parent.mailbox.status !== 'open') return undefined
    const parentState = projectAgentSession(accepted.parent.snapshot())
    const root = parentState.roots.find(item => item.id === accepted.event.payload.parentRoot)!
    let child = this.#children.get(id)
    if (child === undefined) return async () => {
      const lease = await this.#lifetimes.run('child:' + id, effect => effect.apply('child lifetime', () => new ChildInstance({ ...this.options, accepted, admission: this.admission, ...(this.#restored.get(id) == null ? {} : { restored: this.#restored.get(id)! }) }), value => value.dispose()))
      this.#children.set(id, lease.value)
    }
    if (this.#failed.has(id) && !parentState.subagents.provisions.some(item => item.payload.delegation === id)) {
      if (child.executionReleased === undefined) return () => child.releaseExecution()
      if (child.protocolReleased === undefined) return () => child.releaseProtocol()
      if (child.session !== undefined) {
        const resources = projectAgentSession(child.session.snapshot()).subagents.resources
        const pending = resources.find(item => effectiveResourceRelease(item, projectAgentSession(child.session!.snapshot()).subagents.recoveries) === null)
        if (pending !== undefined) return () => child.recordRelease(pending.opened.payload.component)
      }
      return () => accepted.journal.append(events.subagentProvisionSettledEvent, () => ({ ...child.identity, outcome: 'failed' as const, child: null,
        phase: 'execution' as const, cleanup: child.executionReleased === 'released' && child.protocolReleased === 'released' ? 'released' as const : 'cleanup-incomplete' as const,
        reasonCode: 'child-acquisition-failed' }))
    }
    const stopped = parentState.subagents.controls.some(item => item.requested.payload.delegation === id)
      || parentState.subagents.failures.some(item => item.payload.delegation === id)
      || root.outcome !== null && root.outcome !== 'completed' || root.stopControl !== null || clockTimestamp(this.options.clock) >= accepted.event.payload.deadline
    if (!stopped && (isModelAdmissionPending(accepted.parent.snapshot())
      || child.session !== undefined && isModelAdmissionPending(child.session.snapshot()))) return undefined
    if ((!stopped || this.#restored.has(id) || child.session !== undefined) && !this.#failed.has(id)) {
      const install = child.installationAction(stopped)
      if (install !== undefined) return install
    }
    if (child.session === undefined || child.journal === undefined) {
      if (stopped && child.executionReleased === undefined) return () => child.releaseExecution()
      const cancellation = parentState.subagents.controls.find(item => item.requested.payload.delegation === id && item.settled === null)
      if (cancellation !== undefined && parentState.subagents.provisions.some(item => item.payload.delegation === id && item.payload.outcome === 'failed')) return () => accepted.journal.append(events.subagentControlSettledEvent, () => ({ ...child.identity, control: cancellation.requested.stored.eventId, business: 'not-started' as const, root: null, executionRelease: null, reasonCode: 'cancelled-before-installation' }))
      if (stopped && !parentState.subagents.provisions.some(item => item.payload.delegation === id)) return () => accepted.journal.append(events.subagentProvisionSettledEvent, () => ({ ...child.identity,
        outcome: 'failed' as const, child: null, phase: 'session' as const, cleanup: 'not-needed' as const, reasonCode: 'parent-stopped-before-child' }))
      const incoming = classificationAction(accepted, accepted.parent, accepted.journal, parent.mailbox)
      if (incoming !== undefined) return incoming
      const closure = delegationClosure(parentState, id, accepted.parent.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known'))
      if (closure.closed) return async () => { this.options.communication.delegationChannels.retire(accepted.lease); this.admission.executionReleased(id); this.#retired.add(id) }
      return undefined
    }
    const session = child.session; const journal = child.journal
    const state = projectAgentSession(session.snapshot())
    if (stopped && state.subagents.bound !== null && state.subagents.controls.length === 0) return async () => {
      this.notifyParentStop(accepted.parentKey, root.id)
      await journal.append(events.subagentControlRequestedV2Event, () => ({ ...child.identity, kind: 'cancel' as const,
        source: root.stopControl === null ? { kind: 'controller' as const, requestKey: 'parent-stop:' + root.id } : { kind: 'parent-stop' as const, eventId: root.stopControl },
        reasonCode: 'parent-stopped-or-deadline', observedAt: clockTimestamp(this.options.clock) }))
    }
    const childRoot = state.roots[0]
    if (child.slot === undefined || child.slot.agent.status !== 'accepting') {
      const stopping = agentStopAction(session, journal, this.options.clock)
      if (stopping !== undefined) return stopping
    }
    const stopProtocol = protocolFailureAction(accepted, accepted.parent, accepted.journal, parent.mailbox, stopped)
      ?? (child.mailbox?.status === 'open' ? protocolFailureAction(accepted, session, journal, child.mailbox, state.subagents.controls.length > 0) : undefined)
    if (stopProtocol !== undefined) return stopProtocol
    if (state.subagents.controls.length > 0 && childRoot?.outcome === null && childRoot.stopControl === null) return () => journal.append(agentControlRequestedEvent,
      () => ({ kind: 'cancel-work' as const, root: childRoot.id, reason: 'delegation-stopped' }))
    if (child.mailbox !== undefined && child.mailbox.status === 'open') {
      const classified = classificationAction(accepted, session, journal, child.mailbox)
      if (classified !== undefined) return classified
    }
    const childBusinessEnded = childRoot?.outcome != null || state.subagents.controls.length > 0 && childRoot === undefined
    if (childBusinessEnded && state.openRun === null) {
      if (child.executionReleased === undefined) return () => child.releaseExecution()
      const resource = state.subagents.resources.find(item => item.opened.payload.component === 'execution' && effectiveResourceRelease(item, state.subagents.recoveries) === null)
      if (resource !== undefined) return () => child.recordRelease('execution')
      const control = state.subagents.controls.find(item => item.settled === null)
      if (control !== undefined) return () => journal.append(events.subagentControlSettledEvent, () => ({ ...child.identity, control: control.requested.stored.eventId,
        business: childRoot === undefined ? 'not-started' as const : 'terminal' as const, root: childRoot?.id ?? null,
        executionRelease: (() => { const resource = state.subagents.resources.filter(item => item.opened.payload.component === 'execution').at(-1); return resource === undefined ? null : effectiveResourceRelease(resource, state.subagents.recoveries)?.eventId ?? null })(), reasonCode: 'child-stopped' }))
    }
    const observation = childSettlementObservation(accepted, session.snapshot())
    const previous = parentState.subagents.observations.filter(item => item.payload.delegation === id).at(-1)?.payload
    if (observation !== undefined && observationChanged(previous, observation)) return () => accepted.journal.append(events.subagentSettlementObservedEvent, () => observation)
    const task = taskProtocolAction(accepted, this.options.clock)
    if (task !== undefined && !stopped) return task
    const result = resultProtocolAction(accepted, session, journal, this.options.clock)
    if (result !== undefined) return result
    const outgoing = protocolSendAction(accepted, accepted.parent, parent.mailbox, this.options.communication)
    if (outgoing !== undefined) return outgoing
    if (child.mailbox?.status === 'open') {
      const send = protocolSendAction(accepted, session, child.mailbox, this.options.communication)
      if (send !== undefined) return send
    }
    const incoming = classificationAction(accepted, accepted.parent, accepted.journal, parent.mailbox)
    if (incoming !== undefined) return incoming
    const pendingParentControl = parentState.subagents.controls.find(item => item.requested.payload.delegation === id && item.settled === null)
    if (pendingParentControl !== undefined && observation !== undefined && observation.business.kind !== 'pending') {
      const business = observation.business
      return () => accepted.journal.append(events.subagentControlSettledEvent, () => ({ ...child.identity, control: pendingParentControl.requested.stored.eventId,
        business: business.kind === 'terminal' ? 'terminal' as const : 'not-started' as const, root: business.kind === 'terminal' ? business.root : null,
        executionRelease: observation.resources.filter(item => item.component === 'execution').at(-1)?.release ?? null, reasonCode: 'child-stop-observed' }))
    }
    const closure = delegationClosure(parentState, id, accepted.parent.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known'))
    if (closure.businessResolved && closure.executionReleased && closure.inputDisposed
      && protocolSettled(parentState.subagents, id, accepted.parent.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known'))
      && protocolSettled(state.subagents, id, session.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known'))) {
      if (child.protocolReleased === undefined) return () => child.releaseProtocol()
      const pending = state.subagents.resources.find(item => item.opened.payload.component === 'protocol' && effectiveResourceRelease(item, state.subagents.recoveries) === null)
      if (pending !== undefined) return () => child.recordRelease('protocol')
      const parentProtocol = parentState.subagents.resources.find(item => item.opened.payload.delegation === id && effectiveResourceRelease(item, parentState.subagents.recoveries) === null)
      if (parentProtocol !== undefined) return () => accepted.journal.append(events.subagentReleaseRecordedEvent, () => ({ ...child.identity,
        opened: parentProtocol.opened.stored.eventId, component: 'protocol' as const, outcome: 'released' as const, reasonCode: 'delegation-protocol-joined' }))
      if (closure.closed) return async () => { this.options.communication.delegationChannels.retire(accepted.lease); this.#retired.add(id) }
    }
    return undefined
  }

  dispose(): Promise<void> {
    this.closeAdmission()
    this.#dispose ??= (async () => {
      const results = await Promise.allSettled([this.#lifetimes.dispose()])
      for (const accepted of this.admission.accepted) {
        const resources = projectAgentSession(accepted.parent.snapshot()).subagents.resources.filter(item => item.opened.payload.delegation === accepted.event.stored.eventId && effectiveResourceRelease(item, projectAgentSession(accepted.parent.snapshot()).subagents.recoveries) === null)
        for (const resource of resources) results.push(...await Promise.allSettled([accepted.journal.append(events.subagentReleaseRecordedEvent, () => ({
          delegation: accepted.event.stored.eventId, parentAddress: accepted.event.payload.parentAddress, childAddress: accepted.event.payload.childAddress,
          opened: resource.opened.stored.eventId, component: 'protocol' as const, outcome: 'released' as const, reasonCode: 'host-protocol-stopped' })).then(() => undefined)]))
      }
      const failures = results.filter(item => item.status === 'rejected').map(item => item.reason)
      if (failures.length > 0) throw new HostError('HOST_CLEANUP_FAILED', 'child-lifetimes-retained', {}, { cause: new AggregateError(failures) })
    })()
    return this.#dispose
  }
}

import { effectiveResourceRelease } from '../subagent/resource-evidence.js'
import { EffectOwner } from '../effect/owner.js'
import type { Clock } from '../foundation/clock.js'
import { AgentJournal } from '../agent/journal.js'
import { projectAgentSession } from '../agent/projection.js'
import { installAgentSpec } from '../agent/session-agent.js'
import { SessionContext } from '../context/session-context.js'
import type { CommunicationService } from '../communication/service.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import type { SessionMailbox } from '../communication/mailbox.js'
import type { SessionRepository } from '../session/repository.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { AcceptedDelegation, SubagentAdmission } from '../subagent/admission.js'
import { SessionSubagentActions } from '../subagent/actions.js'
import * as events from '../subagent/session-events.js'
import { createHostExecution } from './slot.js'
import type { HostRuntimeBindings } from './slot.js'
import { HostSlotOwner } from './slot-owner.js'
import type { HostSlot, HostProtocolSlot } from './runtime-types.js'
import type { ResolvedHostLocalMember } from './config.js'
import { HostError } from './errors.js'

export interface ChildInstanceOptions {
  readonly accepted: AcceptedDelegation
  readonly restored?: SessionHandle
  readonly admission: SubagentAdmission
  readonly repository: SessionRepository
  readonly communication: CommunicationService
  readonly catalog: MessageCatalog
  readonly clock: Clock
  readonly credentials: Readonly<Record<string, string>>
  readonly protectedRoots: readonly string[]
  readonly bindings: HostRuntimeBindings
  readonly slots: HostSlot[]
  readonly protocolSlots: HostProtocolSlot[]
  readonly childAddresses: Set<string>
}

/** A fixed child identity with separate Effect-owned protocol and execution generations. */
export class ChildInstance {
  readonly #protocol = new EffectOwner('child protocol')
  readonly #execution: HostSlotOwner
  #session: SessionHandle | undefined
  #journal: AgentJournal | undefined
  #mailbox: SessionMailbox | undefined
  #slot: HostSlot | undefined
  #executionReleased: 'released' | 'cleanup-incomplete' | undefined
  #protocolReleased: 'released' | 'cleanup-incomplete' | undefined
  #releaseExecution: Promise<void> | undefined
  #releaseProtocol: Promise<void> | undefined
  #dispose: Promise<void> | undefined
  #published = false
  constructor(readonly options: ChildInstanceOptions) {
    this.#session = options.restored
    if (this.#session !== undefined) this.#journal = new AgentJournal(this.#session, options.accepted.event.payload.effectivePlan.template.limits.maxProtocolConflicts, options.clock)
    this.#execution = new HostSlotOwner(options.accepted.event.payload.childSessionId, async () => {
      const session = this.#session!
      const template = options.accepted.event.payload.effectivePlan.template
      const member = this.#member()
      return createHostExecution(session, member, options.communication, options.catalog, options.clock, options.credentials,
        options.protectedRoots, options.bindings, this.#mailbox!, { subagentActions: new SessionSubagentActions(session, member.agentKey, options.admission, options.clock), childTools: template.tools,
          ...(options.accepted.workspaceLease === undefined ? {} : { workspaceAccess: options.accepted.workspaceLease, workspaceLease: options.accepted.workspaceLease }) })
    })
  }
  #member(): ResolvedHostLocalMember {
    const session = this.#session!
    const state = projectAgentSession(session.snapshot())
    const template = this.options.accepted.event.payload.effectivePlan.template
    const { profileEventId: _profile, ...spec } = state.spec!.payload
    return { kind: 'local', agentKey: 'child.' + session.header.sessionId, sessionId: session.header.sessionId,
      mode: 'create', enabled: true, profile: template.profile, spec, model: template.model, tools: { kind: 'none' } }
  }
  get session() { return this.#session }
  get journal() { return this.#journal }
  get mailbox() { return this.#mailbox }
  get slot() { return this.#slot }
  get executionReleased() { return this.#executionReleased }
  get protocolReleased() { return this.#protocolReleased }
  get identity() {
    const cp = this.options.accepted.event
    return { delegation: cp.stored.eventId, parentAddress: cp.payload.parentAddress, childAddress: cp.payload.childAddress }
  }

  /** Return one local installation/resource action; the Host scheduler owns its accepted task. */
  installationAction(stopping = false): (() => Promise<unknown>) | undefined {
    const { accepted, clock } = this.options
    const p = accepted.event.payload
    const parentState = projectAgentSession(accepted.parent.snapshot())
    if (parentState.subagents.provisions.some(item => item.payload.delegation === accepted.event.stored.eventId && item.payload.outcome !== 'installed')) return undefined
    if (this.#published && parentState.subagents.provisions.some(item => item.payload.delegation === accepted.event.stored.eventId)) return undefined
    const parentTurn = parentState.turns.filter(item => item.root === p.parentRoot).at(-1)
    const root = parentState.roots.find(item => item.id === p.parentRoot)
    if (!stopping && this.options.restored === undefined && (root?.outcome !== null || root.stopControl !== null || parentTurn?.settled?.payload.outcome !== 'waiting' || parentState.openTurn !== null)) return undefined
    if (stopping && this.#session === undefined) return undefined
    if (this.#session === undefined) return async () => {
      this.#session = await this.options.repository.create({ sessionId: p.childSessionId })
      this.#journal = new AgentJournal(this.#session, p.effectivePlan.template.limits.maxProtocolConflicts, clock)
    }
    const session = this.#session; const journal = this.#journal!
    const state = projectAgentSession(session.snapshot())
    if (state.subagents.bound === null) return () => journal.append(events.childBoundEvent, () => ({ ...this.identity, requested: p }))
    if (stopping && !parentState.subagents.provisions.some(item => item.payload.delegation === accepted.event.stored.eventId && item.payload.outcome === 'installed')) return undefined
    if (state.spec === null) {
      const profile = session.snapshot().history.at(-1)!.events.find(item => item.stored.type === 'context/profile-recorded')
      if (profile === undefined) return async () => {
        const context = new SessionContext({ session, messageCatalog: this.options.catalog })
        try { return await context.recordProfile(p.effectivePlan.template.profile) } finally { await context.dispose() }
      }
      return () => installAgentSpec(session, { ...p.effectivePlan.template.spec, profileEventId: profile.stored.eventId, budget: p.grant,
        subagents: { role: 'child', bound: state.subagents.bound!.stored.eventId, deadline: p.deadline, protocolReserve: p.childProtocolReserve,
          maxQuestions: p.effectivePlan.template.maxQuestions, maxProgress: p.effectivePlan.template.maxProgress,
          maxFileEntries: p.effectivePlan.template.limits.maxFileEntries } }, clock)
    }
    if (state.subagents.ready === null) return () => journal.append(events.childReadyEvent, (_, snapshot) => ({ ...this.identity,
      bound: state.subagents.bound!.stored.eventId, profile: state.spec!.payload.profileEventId, spec: state.spec!.stored.eventId, through: snapshot.localPosition }))
    const parentProtocol = parentState.subagents.resources.filter(item => item.opened.payload.delegation === accepted.event.stored.eventId && item.opened.payload.component === 'protocol').at(-1)
    if (parentProtocol === undefined || effectiveResourceRelease(parentProtocol, parentState.subagents.recoveries) !== null) return () => accepted.journal.append(events.subagentResourceOpenedEvent, () => ({ ...this.identity,
      generation: (parentProtocol?.opened.payload.generation ?? 0) + 1, component: 'protocol' as const, predecessor: parentProtocol === undefined ? null : effectiveResourceRelease(parentProtocol, parentState.subagents.recoveries)!.eventId, recovery: parentProtocol === undefined ? null : effectiveResourceRelease(parentProtocol, parentState.subagents.recoveries)!.recovery, workspaceGrant: { kind: 'none' as const } }))
    const protocol = state.subagents.resources.filter(item => item.opened.payload.component === 'protocol').at(-1)
    if (protocol === undefined || effectiveResourceRelease(protocol, state.subagents.recoveries) !== null) return () => journal.append(events.subagentResourceOpenedEvent, () => ({ ...this.identity,
      generation: (protocol?.opened.payload.generation ?? 0) + 1, component: 'protocol' as const, predecessor: protocol === undefined ? null : effectiveResourceRelease(protocol, state.subagents.recoveries)!.eventId, recovery: protocol === undefined ? null : effectiveResourceRelease(protocol, state.subagents.recoveries)!.recovery, workspaceGrant: { kind: 'none' as const } }))
    if (this.#mailbox === undefined) return async () => {
      this.options.communication.delegationChannels.bindChild(accepted.lease, session)
      this.options.childAddresses.add(p.childAddress)
      const lease = await this.#protocol.run('mailbox', effect => effect.apply('mailbox', () => this.options.communication.attach(session, {
        catalog: this.options.catalog, policy: { canSend: () => ({ kind: 'deny', reasonCode: 'delegation-only' }), canReceive: () => ({ kind: 'deny', reasonCode: 'delegation-only' }) },
      }), value => value.dispose()))
      this.#mailbox = lease.value
      if (stopping || state.roots[0]?.outcome != null || root?.outcome != null || root?.stopControl != null || clock.now() >= Date.parse(p.deadline)) this.#published = true
      this.options.protocolSlots.push({ member: this.#member(), session, mailbox: this.#mailbox, dispatcher: this.options.communication.createDispatcher(this.#mailbox) })
    }
    if (stopping || state.roots[0]?.outcome != null || root?.outcome != null || root?.stopControl != null || clock.now() >= Date.parse(p.deadline)) return undefined
    const execution = state.subagents.resources.filter(item => item.opened.payload.component === 'execution').at(-1)
    if (execution === undefined || effectiveResourceRelease(execution, state.subagents.recoveries) !== null) return () => journal.append(events.subagentResourceOpenedEvent, () => ({ ...this.identity,
      generation: (execution?.opened.payload.generation ?? 0) + 1, component: 'execution' as const, predecessor: execution === undefined ? null : effectiveResourceRelease(execution, state.subagents.recoveries)!.eventId, recovery: execution === undefined ? null : effectiveResourceRelease(execution, state.subagents.recoveries)!.recovery, workspaceGrant: p.effectivePlan.workspace }))
    if (this.options.accepted.workspaceLease !== undefined && !state.subagents.baselines.some(item => item.payload.execution === execution.opened.stored.eventId)) return async () => {
      const baseline = await this.options.accepted.workspaceLease!.baseline()
      await journal.append(events.workspaceBaselineRecordedEvent, () => ({ ...this.identity, execution: execution.opened.stored.eventId, baseline }))
    }
    if (this.#slot === undefined) return async () => { this.#slot = await this.#execution.open(); this.options.slots.push(this.#slot); this.#published = true }
    if (parentState.subagents.provisions.some(item => item.payload.delegation === accepted.event.stored.eventId)) return undefined
    return () => accepted.journal.append(events.subagentProvisionSettledEvent, () => ({ ...this.identity, outcome: 'installed' as const,
      child: { bound: state.subagents.bound!.stored.eventId, profile: state.spec!.payload.profileEventId, spec: state.spec!.stored.eventId,
        ready: state.subagents.ready!.stored.eventId, protocol: protocol.opened.stored.eventId, execution: execution.opened.stored.eventId },
      phase: 'published' as const, cleanup: 'not-needed' as const, reasonCode: 'child-published' }))
  }

  releaseExecution(): Promise<void> {
    this.#releaseExecution ??= this.#execution.dispose().then(async () => {
      await this.options.accepted.workspaceLease?.dispose(); this.#executionReleased = 'released'
      const index = this.#slot === undefined ? -1 : this.options.slots.indexOf(this.#slot)
      if (index >= 0) this.options.slots.splice(index, 1)
    }).catch(() => { this.#executionReleased = 'cleanup-incomplete' })
    return this.#releaseExecution
  }
  releaseProtocol(): Promise<void> {
    this.#releaseProtocol ??= this.#protocol.dispose().then(() => {
      this.#protocolReleased = 'released'; this.options.childAddresses.delete(this.options.accepted.event.payload.childAddress)
      const index = this.options.protocolSlots.findIndex(item => item.mailbox === this.#mailbox)
      if (index >= 0) this.options.protocolSlots.splice(index, 1)
    }, () => { this.#protocolReleased = 'cleanup-incomplete' })
    return this.#releaseProtocol
  }
  dispose(): Promise<void> {
    this.#dispose ??= (async () => {
      await this.releaseExecution()
      const executionRecord = await Promise.allSettled([this.recordRelease('execution')])
      await this.releaseProtocol()
      const protocolRecord = await Promise.allSettled([this.recordRelease('protocol')])
      const failures = [...executionRecord, ...protocolRecord].filter(item => item.status === 'rejected').map(item => item.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'child release records incomplete')
      if (this.#executionReleased !== 'released' || this.#protocolReleased !== 'released') throw new HostError('HOST_CLEANUP_FAILED', 'child-resources-retained')
    })()
    return this.#dispose
  }
  async recordRelease(component: 'execution' | 'protocol'): Promise<void> {
    if (this.#journal === undefined) return
    if (this.#journal.faulted) throw new HostError('HOST_RECOVERY_REQUIRED', 'child-release-not-writable')
    const resource = projectAgentSession(this.#session!.snapshot()).subagents.resources.filter(item => item.opened.payload.component === component).at(-1)
    const outcome = component === 'execution' ? this.#executionReleased : this.#protocolReleased
    if (resource === undefined || effectiveResourceRelease(resource, projectAgentSession(this.#session!.snapshot()).subagents.recoveries) !== null || outcome === undefined) return
    await this.#journal.append(events.subagentReleaseRecordedEvent, () => ({ ...this.identity, opened: resource.opened.stored.eventId, component, outcome,
      reasonCode: outcome === 'released' ? 'resources-joined' : 'cleanup-incomplete' }))
    if (component === 'execution' && outcome === 'released') this.options.admission.executionReleased(this.options.accepted.event.stored.eventId)
  }
}

import type { WorkspaceAuthority, WorkspaceLease } from './workspace.js'
import { randomUUID } from 'node:crypto'
import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import { SerialGate } from '../foundation/serial-gate.js'
import { assertDelegationRecordCapacity } from './record-budget.js'
import { AgentJournal } from '../agent/journal.js'
import { projectAgentSession } from '../agent/projection.js'
import { equal } from '../agent/validation.js'
import type { SessionHandle } from '../session/session-handle.js'
import { parseSessionId, formatSessionAddress } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { createChannelId } from '../communication/ids.js'
import type { CommunicationService } from '../communication/service.js'
import type { DelegationChannelLease } from '../communication/delegation-channels.js'
import type { HostSubagentConfig } from '../host/subagent-config.js'
import type { DelegationRequested, DelegationSource } from './event-contract.js'
import { decodeDelegationRequest } from './request.js'
import { delegationDeadline, reserveDelegationBudget } from './budget.js'
import { authorizeDelegation } from './authority.js'
import { delegationClosure } from './closure.js'
import { delegationRequestedEvent } from './session-events.js'
import { SubagentError } from './errors.js'

export type AcceptedDelegation = {
  readonly parentKey: string
  readonly parent: SessionHandle
  readonly journal: AgentJournal
  readonly event: CommittedSessionEvent<DelegationRequested>
  readonly lease: DelegationChannelLease
  readonly workspaceLease?: WorkspaceLease
}
export type DelegationReceipt = { readonly delegationId: SessionEventId; readonly childAddress: string; readonly childSessionId: string }

/** The Host-wide serial owner publishes reservations only after CP-D acknowledgement. */
export class SubagentAdmission {
  readonly #gate = new SerialGate()
  readonly #accepted = new Map<SessionEventId, AcceptedDelegation>()
  readonly #active = new Set<SessionEventId>()
  readonly #pausedParents = new Set<string>()
  executionReleased(id: SessionEventId): void { this.#active.delete(id) }
  pauseParent(key: string): void { this.#pausedParents.add(key) }
  resumeParent(key: string): void { this.#pausedParents.delete(key) }
  drain(): Promise<void> { return this.#gate.run(async () => undefined) }
  #accepting = true
  #uncertain = false
  constructor(readonly config: Extract<HostSubagentConfig, { kind: 'enabled' }>, readonly communication: CommunicationService, readonly clock: Clock, readonly workspaces?: WorkspaceAuthority) {}
  get accepted(): readonly AcceptedDelegation[] { return [...this.#accepted.values()] }
  closeAdmission(): void { this.#accepting = false }

  async restore(parentKey: string, parent: SessionHandle, event: CommittedSessionEvent<DelegationRequested>): Promise<AcceptedDelegation> {
    const lease = await this.communication.delegationChannels.restore(parent, event)
    const accepted = { parentKey, parent, event, lease, journal: new AgentJournal(parent, this.config.limits.maxProtocolConflicts, this.clock) }
    this.#accepted.set(event.stored.eventId, accepted)
    return accepted
  }
  authorizeResume(accepted: AcceptedDelegation, business: boolean): AcceptedDelegation {
    const current = this.config.parents.find(item => item.agentKey === accepted.parentKey)
    const request = accepted.event.payload
    const template = this.config.templates.find(item => item.templateKey === request.request.templateKey && item.templateVersion === request.request.templateVersion)
    if (template === undefined || !equal(template, request.effectivePlan.template)) forbidden('resume-template-or-authority-changed')
    if (!business) return accepted
    if (current === undefined) forbidden('resume-parent-revoked')
    if (!current.templates.some(item => item.templateKey === template.templateKey && item.templateVersion === template.templateVersion)) forbidden('resume-template-revoked')
    decodeDelegationRequest(request.request, this.config.limits)
    for (const key of Object.keys(request.grant) as (keyof typeof request.grant)[]) {
      if (request.grant[key] > current.maxGrant[key]) forbidden('resume-grant-revoked')
    }
    for (const key of ['maxResultBytes', 'maxFileEntries'] as const) {
      if (template.limits[key] > this.config.limits[key]) forbidden('resume-limit-reduced')
    }
    const spec = projectAgentSession(accepted.parent.snapshot()).spec!.payload
    if (spec.protocolVersion !== 2 || spec.subagents.role !== 'parent') forbidden('resume-parent-role')
    authorizeDelegation({ providerId: template.spec.target.provider.providerId, model: template.spec.target.model, tools: template.spec.toolNames }, request.effectivePlan.workspace,
      [spec.subagents.capabilities, template.capabilities, current.capabilities])
    if (!this.#active.has(accepted.event.stored.eventId) && this.#active.size >= this.config.limits.maxActiveChildren) throw new SubagentError('SUBAGENT_CAPACITY', 'active-child-limit')
    const workspaceLease = request.effectivePlan.workspace.kind === 'none' || template.tools.kind === 'none' ? undefined
      : this.workspaces!.reserve(request.effectivePlan.workspace, template.tools.maxBaselineFiles, template.tools.maxBaselineBytes)
    this.#active.add(accepted.event.stored.eventId)
    if (workspaceLease === undefined) return accepted
    const updated = { ...accepted, workspaceLease }; this.#accepted.set(accepted.event.stored.eventId, updated); return updated
  }

  spawn(parentKey: string, parent: SessionHandle, rootId: SessionEventId, source: DelegationSource, raw: unknown): Promise<DelegationReceipt> {
    const request = decodeDelegationRequest(raw, this.config.limits)
    return this.#gate.run(async () => {
      const state = projectAgentSession(parent.snapshot())
      const current = this.config.parents.find(item => item.agentKey === parentKey)
      if (current === undefined || state.spec?.payload.protocolVersion !== 2 || state.spec.payload.subagents.role !== 'parent') forbidden('parent-not-authorized')
      const prior = state.subagents.delegations.find(item => item.payload.parentRoot === rootId && equal(item.payload.source, source))
      if (prior !== undefined) {
        if (!equal(prior.payload.request, request)) throw new SubagentError('SUBAGENT_REQUEST_CONFLICT', 'request-key-content-conflict')
        return receipt(prior)
      }
      if (!this.#accepting || this.#uncertain || this.#pausedParents.has(parentKey)) throw new SubagentError('SUBAGENT_INACTIVE', 'admission-closed')
      const spec = state.spec.payload
      if (spec.subagents.role !== 'parent') forbidden('parent-role')
      const template = this.config.templates.find(item => item.templateKey === request.templateKey && item.templateVersion === request.templateVersion)
      if (template === undefined || !current.templates.some(item => item.templateKey === request.templateKey && item.templateVersion === request.templateVersion)) forbidden('template-not-authorized')
      decodeDelegationRequest(request, template.limits)
      for (const field of ['maxRequestBytes', 'maxMaterialBytes', 'maxResultBytes', 'maxFileEntries'] as const) {
        if (template.limits[field] > this.config.limits[field]) forbidden('template-exceeds-current-limit')
      }
      authorizeDelegation({ providerId: template.spec.target.provider.providerId, model: template.spec.target.model, tools: template.spec.toolNames }, request.workspace,
        [spec.subagents.capabilities, template.capabilities, current.capabilities])
      if (request.workspace.kind !== 'none' && (template.tools.kind !== 'workspace-text' || this.workspaces === undefined)) forbidden('workspace-capability-required')
      if (request.workspace.kind === 'none' && template.tools.kind !== 'none' || request.workspace.kind === 'shared-read' && template.tools.kind === 'workspace-text' && template.tools.write) forbidden('workspace-tool-mode')
      const unresolved = [...this.#accepted.values()].filter(item => !delegationClosure(projectAgentSession(item.parent.snapshot()), item.event.stored.eventId,
        item.parent.snapshot().history.at(-1)!.events.filter(event => event.kind === 'known')).closed)
      if (unresolved.length >= this.config.limits.maxUnresolvedDelegations) throw new SubagentError('SUBAGENT_CAPACITY', 'unresolved-delegation-limit')
      if (this.#active.size >= this.config.limits.maxActiveChildren) throw new SubagentError('SUBAGENT_CAPACITY', 'active-child-limit')
      const root = state.roots.find(item => item.id === rootId)
      if (root === undefined || root.outcome !== null || root.stopControl !== null) throw new SubagentError('SUBAGENT_STATE_INVALID', 'parent-root-stopped')
      if (state.subagents.delegations.filter(item => item.payload.parentRoot === rootId).length >= current.maxDelegations) forbidden('current-delegation-limit')
      const observedAt = clockTimestamp(this.clock)
      const deadline = delegationDeadline(root.deadline, observedAt, template.spec.rootDurationMs, this.config.limits.maxChildDurationMs)
      const reserved = reserveDelegationBudget({ parentUsed: root.budget, parentLimit: spec.budget, requested: request.requestedBudget,
        templateCap: template.spec.budget, parentGrantCap: current.maxGrant, parentMaxOutputTokens: spec.target.maxOutputTokens,
        childMaxOutputTokens: template.spec.target.maxOutputTokens, maxQuestions: template.maxQuestions, maxProgress: template.maxProgress })
      const childSessionId = parseSessionId(randomUUID())
      const payload: DelegationRequested = { parentAddress: parent.header.address, childAddress: formatSessionAddress(childSessionId), childSessionId,
        channelId: createChannelId(), parentRoot: rootId, source, request, grant: request.requestedBudget,
        effectivePlan: { template, workspace: request.workspace, childBudget: request.requestedBudget, deadline },
        parentProtocolReserve: reserved.parentProtocolReserve, childProtocolReserve: reserved.childProtocolReserve, mailboxReserve: reserved.mailboxReserve, deadline, observedAt }
      assertDelegationRecordCapacity(payload, parent.maxRecordBytes, this.communication.delegationChannels.limits.maxMessageBytes)
      const journal = new AgentJournal(parent, this.config.limits.maxProtocolConflicts, this.clock)
      const workspaceLease = request.workspace.kind === 'none' || template.tools.kind !== 'workspace-text' ? undefined
        : this.workspaces!.reserve(request.workspace, template.tools.maxBaselineFiles, template.tools.maxBaselineBytes)
      let event: CommittedSessionEvent<DelegationRequested> | undefined
      try {
        const lease = await this.communication.delegationChannels.admit(parent, payload, async () => {
          event = await journal.append(delegationRequestedEvent, () => payload); return event
        })
        this.#accepted.set(event!.stored.eventId, { parentKey, parent, journal, event: event!, lease, ...(workspaceLease === undefined ? {} : { workspaceLease }) })
        this.#active.add(event!.stored.eventId)
        return receipt(event!)
      } catch (cause) {
        if (journal.faulted || event !== undefined) this.#uncertain = true
        else await workspaceLease?.dispose()
        throw cause
      }
    })
  }
}
function receipt(event: CommittedSessionEvent<DelegationRequested>): DelegationReceipt {
  return Object.freeze({ delegationId: event.stored.eventId, childSessionId: event.payload.childSessionId, childAddress: event.payload.childAddress })
}
function forbidden(reason: string): never { throw new SubagentError('SUBAGENT_AUTHORITY_DENIED', reason) }

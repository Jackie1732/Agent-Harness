import type { Clock } from '../foundation/clock.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import type { AgentActionReference } from '../agent/contract.js'
import { projectAgentSession } from '../agent/projection.js'
import { projectAgentReport } from '../agent/report.js'
import { inspectAgentReadiness } from '../agent/readiness.js'
import { assertAgentExecutionQuiescent } from '../agent/execution-health.js'
import { AgentError } from '../agent/errors.js'
import { rootForWait, selectAgentRoot, selectUserInput } from '../agent/observation.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { MessageId } from '../communication/ids.js'
import { delegationReport } from '../subagent/report.js'
import { selectWorkflowArtifact, selectWorkflowOutput } from '../workflow/observation.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import type { SessionTarget } from '../protocol/references.js'
import type { AgentObservation, InputObservation, RootObservation, MessageObservation, DelegationObservation, WorkflowObservation, WorkflowOutputResult, WorkflowArtifactResult, HostStatusResult } from '../protocol/results.js'
import type { HostAssembly } from './assembly.js'
import type { HostCurrentReport } from './report-data.js'
import { workflowReport } from './workflow-report.js'
import { snapshotCuts, mergeCuts } from './read-cuts.js'
import { readEventPage } from './read-events.js'
import type { EventPageQuery } from './read-events.js'
import { HostError } from './errors.js'

export interface HostReadOptions {
  readonly assembly: HostAssembly
  readonly clock: Clock
  readonly instanceId: string
  assertReady(): void
  currentReport(): HostCurrentReport
  activity(): 'idle' | 'run' | 'command'
  flags(agentKey: string): { readonly paused: boolean; readonly faulted: boolean; readonly routingPaused: boolean }
  track<T>(task: () => Promise<T>): Promise<T>
}

/** Online projections consume existing immutable views and retain no Writer authority. */
export class HostReads {
  readonly #options: HostReadOptions
  constructor(options: HostReadOptions) { this.#options = options }

  #member(agentKey: string) {
    this.#options.assertReady()
    const member = this.#options.assembly.local.find(item => item.member.agentKey === agentKey)
    if (member === undefined) throw new HostError('HOST_TARGET_NOT_FOUND', 'member-not-local')
    const snapshot = member.session.snapshot(), flags = this.#options.flags(agentKey)
    return { snapshot, flags, recoveryRequired: member.session.status === 'faulted' || flags.faulted || recoveryBlocked(snapshot) }
  }
  #evidence(snapshot: SessionSnapshot, recoveryRequired: boolean) {
    return { instanceId: this.#options.instanceId, cuts: snapshotCuts(snapshot), recoveryRequired }
  }
  #childrenRequireRecovery(snapshot: SessionSnapshot, roots: ReadonlySet<SessionEventId>): boolean {
    const domain = this.#options.assembly.subagents
    return projectAgentSession(snapshot).subagents.delegations.some(item => roots.has(item.payload.parentRoot)
      && domain?.flags(item.stored.eventId).recoveryRequired === true)
  }
  status(): HostStatusResult {
    this.#options.assertReady()
    const report = this.#options.currentReport()
    return { instanceId: this.#options.instanceId, hostStatus: report.status, activity: this.#options.activity(), report, cuts: report.cuts }
  }
  agent(agentKey: string): AgentObservation {
    const { snapshot, flags, recoveryRequired } = this.#member(agentKey)
    const mailbox = this.#options.assembly.directory.status(snapshot.header.address).kind
    return { agentKey, sessionId: snapshot.header.sessionId, ...flags, mailbox: mailbox === 'unknown' ? 'known-offline' : mailbox,
      readiness: inspectAgentReadiness(snapshot, this.#options.assembly.catalog, new Date(this.#options.clock.now()).toISOString()),
      report: projectAgentReport(snapshot), ...this.#evidence(snapshot, recoveryRequired) }
  }
  input(agentKey: string, query: { readonly inputEventId: SessionEventId } | { readonly namespace: string; readonly key: string }): InputObservation {
    const { snapshot, recoveryRequired } = this.#member(agentKey), input = selectUserInput(snapshot, query)
    if (input === null) throw new HostError(recoveryRequired ? 'HOST_RECOVERY_REQUIRED' : 'HOST_TARGET_NOT_FOUND', 'input-not-certified')
    return { agentKey, sessionId: snapshot.header.sessionId, ...input, ...this.#evidence(snapshot, recoveryRequired) }
  }
  root(agentKey: string, rootId: SessionEventId, textBudget = Number.MAX_SAFE_INTEGER): RootObservation {
    const { snapshot, recoveryRequired } = this.#member(agentKey)
    let root
    try { root = selectAgentRoot(snapshot, rootId, textBudget) }
    catch (cause) {
      if (cause instanceof AgentError && cause.code === 'AGENT_SOURCE_INVALID') throw new HostError('HOST_EVIDENCE_INCOMPLETE', 'root-final-not-certified')
      throw cause
    }
    if (root === null) throw new HostError(recoveryRequired ? 'HOST_RECOVERY_REQUIRED' : 'HOST_TARGET_NOT_FOUND', 'root-not-certified')
    return { agentKey, sessionId: snapshot.header.sessionId, ...root,
      ...this.#evidence(snapshot, recoveryRequired || this.#childrenRequireRecovery(snapshot, new Set([rootId]))) }
  }
  answerRoot(agentKey: string, wait: AgentActionReference): RootObservation {
    const { snapshot, recoveryRequired } = this.#member(agentKey), id = rootForWait(snapshot, wait)
    if (id === null) throw new HostError(recoveryRequired ? 'HOST_RECOVERY_REQUIRED' : 'HOST_TARGET_NOT_FOUND', 'wait-not-owned')
    return this.root(agentKey, id)
  }
  message(agentKey: string, messageId: MessageId, direction: 'outbox' | 'inbox'): MessageObservation {
    const { snapshot, recoveryRequired } = this.#member(agentKey), facts = projectCommunicationFacts(snapshot)
    const evidence = { agentKey, sessionId: snapshot.header.sessionId, ...this.#evidence(snapshot, recoveryRequired) }
    if (direction === 'outbox') {
      const fact = facts.outbox.find(item => item.messageId === messageId)
      if (fact !== undefined) return { direction, fact, ...evidence }
    } else {
      const fact = facts.inbox.find(item => item.messageId === messageId)
      if (fact !== undefined) return { direction, fact, ...evidence }
    }
    throw new HostError(recoveryRequired ? 'HOST_RECOVERY_REQUIRED' : 'HOST_TARGET_NOT_FOUND', 'message-not-certified')
  }
  delegation(parentAgentKey: string, parentRoot: SessionEventId, delegationId: SessionEventId): DelegationObservation {
    const { snapshot, recoveryRequired } = this.#member(parentAgentKey), domain = this.#options.assembly.subagents
    if (domain === undefined) throw new HostError('HOST_TARGET_NOT_FOUND', 'subagents-not-installed')
    const entry = delegationReport([{ parentKey: parentAgentKey, snapshot }], Number.MAX_SAFE_INTEGER, id => domain.flags(id)).delegations.find(item => item.delegationId === delegationId && item.parentRoot === parentRoot)
    if (entry === undefined) throw new HostError(recoveryRequired ? 'HOST_RECOVERY_REQUIRED' : 'HOST_TARGET_NOT_FOUND', 'delegation-not-owned')
    return { ...entry, ...this.#evidence(snapshot, recoveryRequired || entry.recoveryRequired || entry.cleanupIncomplete) }
  }
  #workflow(workflowKey: string) {
    this.#options.assertReady()
    const domain = this.#options.assembly.workflows
    if (domain === undefined) throw new HostError('HOST_TARGET_NOT_FOUND', 'workflow-not-installed')
    const captured = domain.capture(workflowKey), report = workflowReport(captured.session, captured.peers, captured.resumed)
    const cuts = mergeCuts([captured.session, ...captured.peers].flatMap(snapshotCuts))
    const assignments = new Set(projectWorkflowSession(captured.session).assignments.map(item => item.stored.eventId))
    const childRecovery = captured.peers.some(peer => {
      const roots = projectAgentSession(peer).roots.filter(root => root.source.kind === 'workflow'
        && root.source.assignment.address === captured.session.header.address && assignments.has(root.source.assignment.eventId))
      return this.#childrenRequireRecovery(peer, new Set(roots.map(root => root.id)))
    })
    const faulted = this.#options.flags(captured.coordinatorKey).faulted || this.#options.assembly.local.some(member =>
      captured.participants.has(member.session.header.address) && this.#options.flags(member.member.agentKey).faulted)
    const recoveryRequired = captured.faulted || faulted || childRecovery || report.counts.pendingRecoveries > 0 || report.counts.cleanupIncomplete > 0
      || captured.peers.some(peer => captured.participants.has(peer.header.address) && recoveryBlocked(peer))
    return { ...captured, report, evidence: { instanceId: this.#options.instanceId, cuts, recoveryRequired } }
  }
  workflow(workflowKey: string): WorkflowObservation {
    const { report, evidence } = this.#workflow(workflowKey)
    return { ...report, ...evidence }
  }
  output(workflowKey: string, nodeKey: string): WorkflowOutputResult {
    const { session, evidence } = this.#workflow(workflowKey), selected = selectWorkflowOutput(session, nodeKey)
    if (selected.kind === 'node-missing') throw new HostError('HOST_TARGET_NOT_FOUND', 'workflow-node-unknown')
    const base = { workflowKey, nodeKey, instanceId: evidence.instanceId, cuts: evidence.cuts }
    if (selected.kind === 'not-available') {
      if (evidence.recoveryRequired) throw new HostError('HOST_RECOVERY_REQUIRED', 'workflow-output-not-certified')
      return { ...base, status: 'not-available' }
    }
    const { kind: _kind, ...value } = selected
    return { ...base, status: 'available', ...value }
  }
  artifact(workflowKey: string, artifactRef: WorkflowEventRef): WorkflowArtifactResult {
    const { session, evidence } = this.#workflow(workflowKey), selected = selectWorkflowArtifact(session, artifactRef)
    if (selected === null) throw new HostError(evidence.recoveryRequired ? 'HOST_RECOVERY_REQUIRED' : 'HOST_TARGET_NOT_FOUND', 'accepted-artifact-not-certified')
    return { workflowKey, artifactRef, ...selected,
      instanceId: evidence.instanceId, cuts: evidence.cuts }
  }
  async events(target: SessionTarget, query: EventPageQuery) {
    this.#options.assertReady()
    return this.#options.track(async () => {
      let snapshot: SessionSnapshot | undefined
      if (target.kind === 'member') snapshot = this.#member(target.agentKey).snapshot
      else if (target.kind === 'workflow') snapshot = this.#workflow(target.workflowKey).session
      else {
        const parent = this.#member(target.parentAgentKey)
        try { snapshot = await this.#options.assembly.subagents?.readChild(target.parentAgentKey, target.parentRoot, target.delegationId) }
        catch (cause) {
          if (parent.recoveryRequired && cause instanceof HostError && cause.code === 'HOST_TARGET_NOT_FOUND') throw new HostError('HOST_RECOVERY_REQUIRED', 'child-not-certified')
          throw cause
        }
      }
      if (snapshot === undefined) throw new HostError('HOST_TARGET_NOT_FOUND', 'child-not-installed')
      return readEventPage(snapshot, query)
    })
  }
}

/** Active invocations are execution, while unreconciled persistence and cleanup require recovery. */
export function recoveryBlocked(snapshot: SessionSnapshot): boolean {
  const state = projectAgentSession(snapshot)
  if (state.openRecovery !== null || state.subagents.recoveries.some(item => item.settled === null && item.supersededBy === null)) return true
  if (state.openRun !== null) return false
  try { assertAgentExecutionQuiescent(snapshot); return false }
  catch (cause) {
    if (cause instanceof AgentError && ['AGENT_RECOVERY_REQUIRED', 'AGENT_CLEANUP_FAILED'].includes(cause.code)) return true
    throw cause
  }
}

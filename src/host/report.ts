import type { Clock } from '../foundation/clock.js'
import type { HostRunReport, HostSlot } from './runtime-types.js'
import type { HostObservations } from './observation.js'
import { projectAgentSession } from '../agent/projection.js'
import { projectAgentReport } from '../agent/report.js'
import { inspectAgentReadiness } from '../agent/readiness.js'
import type { HostAssembly } from './assembly.js'

/** Count every slot before truncating diagnostic entries. */
export function observeHostMembers(slots: readonly HostSlot[], paused: ReadonlySet<string>, faults: ReadonlySet<string>, clock: Clock, maximum: number, observations: HostObservations,
  assembly: Pick<HostAssembly, 'local' | 'catalog' | 'directory'>, routingPaused: ReadonlySet<string>) {
  const observedAt = new Date(clock.now()).toISOString()
  const members: HostRunReport['members'][number][] = []
  const counts = { members: assembly.local.length, pendingInputs: 0, pendingWaits: 0, pendingOutbox: 0,
    pendingMaintenance: 0, runnableInputs: 0, reviewRequiredInputs: 0, unsupportedInputs: 0, blockedMembers: 0, failedRoots: 0, exhaustedRoots: 0 }
  for (const { member, session } of assembly.local) {
    const slot = slots.find(slot => slot.member.agentKey === member.agentKey)
    const { readiness, agent } = slot === undefined ? {
      readiness: inspectAgentReadiness(session.snapshot(), assembly.catalog, observedAt), agent: projectAgentReport(session.snapshot()),
    } : observations.read(slot, Date.parse(observedAt))
    const mailbox = assembly.directory.status(session.header.address).kind
    const online = mailbox === 'online'
    counts.pendingInputs += agent.counts.pendingInputs
    counts.pendingWaits += agent.counts.pendingWaits
    counts.pendingOutbox += agent.counts.pendingOutbox
    const ordinary = member.spec.protocolVersion === 3 ? projectAgentSession(session.snapshot()).roots.filter(root => root.source.kind === 'ordinary') : undefined
    counts.failedRoots += ordinary === undefined ? agent.counts.failedRoots : ordinary.filter(root => root.outcome === 'failed' || root.outcome === 'result-unknown').length
    counts.exhaustedRoots += ordinary === undefined ? agent.counts.exhaustedRoots : ordinary.filter(root => root.outcome === 'budget-exhausted').length
    counts.pendingMaintenance += readiness.counts.pendingMaintenance
    if (online && !paused.has(member.agentKey)) counts.runnableInputs += readiness.counts.runnableInputs
    counts.reviewRequiredInputs += readiness.counts.reviewRequiredInputs
    counts.unsupportedInputs += readiness.counts.unsupportedInputs
    const faulted = faults.has(member.agentKey) || slot?.agent.status === 'faulted'
    if (faulted || ['recovery-required', 'cleanup-incomplete', 'capacity'].includes(readiness.blockedBy)) counts.blockedMembers++
    if (members.length < maximum) members.push(Object.freeze({ agentKey: member.agentKey, sessionId: member.sessionId,
      paused: paused.has(member.agentKey) || slot === undefined, mailbox: mailbox === 'unknown' ? 'known-offline' : mailbox,
      routingPaused: routingPaused.has(member.agentKey), faulted, readiness, agent: structuredClone(agent) }))
  }
  return Object.freeze({ members: Object.freeze(members), counts: Object.freeze(counts), truncated: assembly.local.length > maximum })
}

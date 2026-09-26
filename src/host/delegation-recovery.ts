import { projectModelSession } from '../model/projection.js'
import { projectToolSession } from '../tool/projection.js'
import { recoverModelInvocation } from '../model/recovery.js'
import { recoverToolSession } from '../tool/recovery.js'
import { hasPendingLowerExecution } from '../subagent/execution-evidence.js'
import type { SessionRepository } from '../session/repository.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import { parseSessionId } from '../session/ids.js'
import type { Clock } from '../foundation/clock.js'
import { AgentJournal } from '../agent/journal.js'
import { projectAgentSession } from '../agent/projection.js'
import { recoverAgentSession } from '../agent/recovery.js'
import { subagentRecoveryRequestedEvent, subagentRecoverySettledEvent } from '../subagent/session-events.js'
import { effectiveResourceRelease } from '../subagent/resource-evidence.js'
import { discoverHostDelegations } from './delegation-discovery.js'
import { isLocalHostMember } from './config.js'
import type { ResolvedHostSpec } from './config.js'
import type { RecoverHostOptions } from './recovery.js'
import { validateHostMemberSession } from './binding.js'
import { HostError } from './errors.js'

/** One recovery invocation shares its write budget across all parent, child and lower-domain journals. */
export async function recoverHostDelegations(spec: ResolvedHostSpec, repository: SessionRepository, options: RecoverHostOptions, clock: Clock) {
  if (options.predecessorStopped !== true || !Number.isSafeInteger(options.maxRecoveryWrites) || options.maxRecoveryWrites < 0) throw new HostError('HOST_CONFIG_INVALID', 'delegation-recovery-options')
  const discovered = await discoverHostDelegations(spec, repository)
  const maximum = spec.schemaVersion !== 1 && spec.subagents.kind === 'enabled' ? Math.min(options.maxRecoveryWrites, spec.subagents.limits.maxRecoveryWrites) : options.maxRecoveryWrites
  const opened = new Map<string, SessionHandle>()
  const through = new Map<string, number>()
  const open = async (id: string) => {
    let session = opened.get(id)
    if (session === undefined) { session = await repository.open(parseSessionId(id)); opened.set(id, session); through.set(id, session.snapshot().localPosition) }
    return session
  }
  const writes = () => [...opened].reduce((sum, [id, session]) => sum + session.snapshot().localPosition - through.get(id)!, 0)
  const pending = new Set<string>()
  const participants = new Map<string, { session: SessionHandle; delegations: SessionEventId[] }>()
  for (const member of spec.members.filter(isLocalHostMember)) {
    const session = await open(member.sessionId)
    validateHostMemberSession(session, spec.hostKey, member, { requireQuiescent: false, allowEnded: true })
    participants.set(member.sessionId, { session, delegations: [] })
  }
  for (const relation of discovered.filter(item => !item.closed)) {
    const parent = participants.get(relation.parent.header.sessionId)!
    parent.delegations.push(relation.requested.stored.eventId)
    if (relation.child !== null && relation.child.localPosition > 0) participants.set(relation.child.header.sessionId, { session: await open(relation.child.header.sessionId), delegations: [relation.requested.stored.eventId] })
    else pending.add('resume-installation:' + relation.requested.stored.eventId)
  }
  const expectedDomains = new Map<string, SessionEventId | null>()
  for (const { session, delegations } of participants.values()) {
    const state = projectAgentSession(session.snapshot())
    expectedDomains.set(session.header.sessionId + ':agent', state.openRecovery)
    for (const delegation of delegations) expectedDomains.set(session.header.sessionId + ':subagent:' + delegation,
      state.subagents.recoveries.find(item => item.requested.payload.delegation === delegation && item.settled === null && item.supersededBy === null)?.requested.stored.eventId ?? null)
  }
  for (const [key, expected] of expectedDomains) if ((options.domainSupersedes?.[key] ?? null) !== expected) throw new HostError('HOST_RECOVERY_REQUIRED', 'recovery-supersedes-mismatch')
  for (const key of Object.keys(options.domainSupersedes ?? {})) if (!expectedDomains.has(key)) throw new HostError('HOST_CONFIG_INVALID', 'unknown-recovery-domain')
  for (const { session, delegations } of participants.values()) {
    let state = projectAgentSession(session.snapshot())
    const needsAgent = state.openRun !== null || state.openRecovery !== null || state.controls.some(item => item.settled === null && item.supersededBy === null)
    const needsLower = hasPendingLowerExecution(session.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known'))
    let ownersReady = true
    const agentKey = session.header.sessionId + ':agent'
    const expectedAgent = options.domainSupersedes?.[agentKey] ?? null
    if (expectedAgent !== state.openRecovery) throw new HostError('HOST_RECOVERY_REQUIRED', 'agent-recovery-supersedes-mismatch')
    const owners: { id: SessionEventId; delegation: SessionEventId; journal: AgentJournal; start: number }[] = []
    for (const delegation of delegations) {
      const previous = state.subagents.recoveries.filter(item => item.requested.payload.delegation === delegation && item.settled === null && item.supersededBy === null).at(-1)
      if ((options.domainSupersedes?.[session.header.sessionId + ':subagent:' + delegation] ?? null) !== (previous?.requested.stored.eventId ?? null)) throw new HostError('HOST_RECOVERY_REQUIRED', 'delegation-recovery-supersedes-mismatch')
      if (!needsAgent && !needsLower && previous === undefined && state.subagents.resources.filter(item => item.opened.payload.delegation === delegation).every(item => effectiveResourceRelease(item, state.subagents.recoveries)?.outcome === 'released')) continue
      if (maximum - writes() < 2 + owners.length) { pending.add('recovery-write-budget'); ownersReady = false; break }
      const request = state.subagents.delegations.find(item => item.stored.eventId === delegation)?.payload ?? state.subagents.bound!.payload.requested
      const journal = new AgentJournal(session, options.maxJournalConflicts, clock)
      const owner = await journal.append(subagentRecoveryRequestedEvent, (_, snapshot) => ({ delegation, parentAddress: request.parentAddress, childAddress: request.childAddress,
        through: snapshot.localPosition, predecessorStopped: true, supersedes: previous?.requested.stored.eventId ?? null, maxWrites: maximum - writes() }))
      owners.push({ id: owner.stored.eventId, delegation, journal, start: owner.payload.through })
      state = projectAgentSession(session.snapshot())
    }
    if (needsAgent && ownersReady) {
      const budget = maximum - writes() - owners.length
      if (budget >= 3) await recoverAgentSession(session, { predecessorStopped: true, supersedes: expectedAgent, maxRecoveryWrites: budget, maxJournalConflicts: options.maxJournalConflicts, clock })
      else pending.add('agent-recovery-write-budget:' + session.header.sessionId)
    }
    if (!needsAgent && needsLower && ownersReady) {
      const model = projectModelSession(session.snapshot()).pendingInvocationId
      if (model !== null && maximum - writes() > owners.length) await recoverModelInvocation(session, { invocationId: model, predecessorStopped: true, maxJournalConflicts: options.maxJournalConflicts })
      if (projectToolSession(session.snapshot()).pendingInvocationId !== null && maximum - writes() > owners.length) await recoverToolSession(session, { predecessorStopped: true, maxJournalConflicts: options.maxJournalConflicts })
    }
    for (const owner of owners) {
      state = projectAgentSession(session.snapshot())
      if (maximum - writes() < 1 || hasPendingLowerExecution(session.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known')) || state.openRun !== null || state.openRecovery !== null || state.controls.some(item => item.settled === null && item.supersededBy === null)) {
        pending.add('open-recovery:' + owner.id); continue
      }
      const request = state.subagents.delegations.find(item => item.stored.eventId === owner.delegation)?.payload ?? state.subagents.bound!.payload.requested
      await owner.journal.append(subagentRecoverySettledEvent, (_, snapshot) => ({ delegation: owner.delegation, parentAddress: request.parentAddress, childAddress: request.childAddress,
        recovery: owner.id, writes: snapshot.localPosition - owner.start + 1, outcome: 'complete' as const, pending: [],
        evidence: state.subagents.resources.filter(item => item.opened.payload.delegation === owner.delegation && item.opened.stored.sequence <= owner.start).map(item => item.opened.stored.eventId) }))
    }
  }
  return Object.freeze([...participants].map(([sessionId, { session }]) => ({ agentKey: spec.members.find(item => item.sessionId === sessionId)?.agentKey ?? 'child.' + sessionId,
    sessionId, result: { kind: pending.size === 0 ? 'delegation-recovered' as const : 'delegation-recovery-pending' as const,
      totalWrites: writes(), maxRecoveryWrites: maximum, pending: [...pending],
      openAgentRecovery: projectAgentSession(session.snapshot()).openRecovery,
      openDelegationRecoveries: projectAgentSession(session.snapshot()).subagents.recoveries.filter(item => item.settled === null && item.supersededBy === null).map(item => item.requested.stored.eventId) } })))
}

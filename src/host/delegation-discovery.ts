import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionRepository } from '../session/repository.js'
import { parseSessionId } from '../session/ids.js'
import type { SessionSnapshot, CommittedSessionEvent } from '../session/types.js'
import { SessionError } from '../session/errors.js'
import { projectAgentSession } from '../agent/projection.js'
import { projectHostSession } from './session-projection.js'
import type { ResolvedHostSpec } from './config.js'
import { equal } from '../agent/validation.js'
import type { DelegationRequested } from '../subagent/event-contract.js'
import { delegationClosure } from '../subagent/closure.js'
import { HostError } from './errors.js'
import { validateDelegationCausality } from '../subagent/causality.js'

export interface DiscoveredDelegation {
  readonly parentKey: string
  readonly parent: SessionSnapshot
  readonly requested: CommittedSessionEvent<DelegationRequested>
  readonly child: SessionSnapshot | null
  readonly closed: boolean
}

/** Bounded one-level inventory detects removed managed parents; children are followed only through committed CP-D references. */
export async function discoverHostDelegations(spec: ResolvedHostSpec, repository: SessionRepository): Promise<readonly DiscoveredDelegation[]> {
  const domain = spec.schemaVersion === 2 ? spec.subagents : { kind: 'disabled' as const }
  const maximum = domain.kind === 'enabled' ? domain.limits.maxDiscoveryEntries : 10000
  const snapshots: SessionSnapshot[] = []
  const directory = await opendir(join(spec.storage.root, 'sessions'))
  let entries = 0
  for await (const entry of directory) {
    if (++entries > maximum) throw new HostError('HOST_RECOVERY_REQUIRED', 'delegation-discovery-limit')
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(entry.name)) continue
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new HostError('HOST_BINDING_CONFLICT', 'session-discovery-entry')
    snapshots.push(await repository.read(parseSessionId(entry.name)))
  }
  const found: DiscoveredDelegation[] = []
  const ownedChildren = new Set<string>()
  for (const parent of snapshots) {
    if (parent.header.parent !== undefined) continue
    const binding = projectHostSession(parent).ready
    if (binding?.payload.hostKey !== spec.hostKey) continue
    const state = projectAgentSession(parent)
    for (const requested of state.subagents.delegations) {
      if (found.length >= maximum || ownedChildren.has(requested.payload.childSessionId)) throw new HostError('HOST_BINDING_CONFLICT', 'delegation-child-identity-conflict')
      ownedChildren.add(requested.payload.childSessionId)
      let child: SessionSnapshot | null = null
      try { child = await repository.read(requested.payload.childSessionId) }
      catch (cause) { if (!(cause instanceof SessionError && cause.code === 'SESSION_NOT_FOUND')) throw cause }
      if (child !== null) {
        if (child.header.parent !== undefined) throw new HostError('HOST_BINDING_CONFLICT', 'delegation-child-is-fork')
        const childState = projectAgentSession(child)
        if (child.localPosition !== 0 && (childState.subagents.bound?.payload.delegation !== requested.stored.eventId
          || !equal(childState.subagents.bound.payload.requested, requested.payload))) throw new HostError('HOST_BINDING_CONFLICT', 'delegation-child-binding')
      }
      const closed = delegationClosure(state, requested.stored.eventId, parent.history.at(-1)!.events.filter(item => item.kind === 'known')).closed
      validateDelegationCausality(parent, child, requested)
      if (!closed && !spec.members.some(member => member.kind === 'local' && member.agentKey === binding.payload.agentKey && member.sessionId === parent.header.sessionId)) throw new HostError('HOST_RECOVERY_REQUIRED', 'removed-parent-has-delegations')
      if (!closed && domain.kind === 'disabled') throw new HostError('HOST_RECOVERY_REQUIRED', 'disabled-subagents-have-obligations')
      if (!closed && domain.kind === 'enabled') {
        const template = domain.templates.find(item => item.templateKey === requested.payload.request.templateKey && item.templateVersion === requested.payload.request.templateVersion)
        if (template === undefined || !equal(template, requested.payload.effectivePlan.template)) throw new HostError('HOST_BINDING_CONFLICT', 'delegation-template-changed')
      }
      found.push({ parentKey: binding.payload.agentKey, parent, requested, child, closed })
    }
  }
  return found.sort((a, b) => a.parentKey.localeCompare(b.parentKey) || a.requested.stored.sequence - b.requested.stored.sequence)
}

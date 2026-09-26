import { recoverHostDelegations } from './delegation-recovery.js'
import { discoverHostDelegations } from './delegation-discovery.js'
import type { Clock } from '../foundation/clock.js'
import { systemClock } from '../foundation/clock.js'
import { projectAgentSession } from '../agent/projection.js'
import { recoverAgentSession } from '../agent/recovery.js'
import { FileSessionBackend } from '../session/file-backend.js'
import { parseSessionId } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import { HostError } from './errors.js'
import { SessionRepository } from '../session/repository.js'
import { isLocalHostMember } from './config.js'
import type { ResolvedHostSpec } from './config.js'
import { validateHostMemberSession } from './binding.js'
import { hostRuntimeEventCatalog } from './initialization.js'
import { acquireHostStorageLock } from './storage-lock.js'
import { scanHostInventory } from './inventory.js'
import { discoverHostWorkflows } from './workflow-discovery.js'
import { validateWorkflowCausality } from '../workflow/causality.js'

export interface RecoverHostOptions {
  readonly predecessorStopped: true
  readonly maxRecoveryWrites: number
  readonly maxJournalConflicts: number
  readonly clock?: Clock
  readonly domainSupersedes?: Readonly<Record<string, SessionEventId | null>>
  readonly supersedes?: Readonly<Record<string, SessionEventId | null>>
}

/** Reconcile interrupted local facts without loading Providers, tools, mailboxes or network listeners. */
export async function recoverHost(spec: ResolvedHostSpec, options: RecoverHostOptions) {
  if (spec.schemaVersion === 1 && Object.keys(options.domainSupersedes ?? {}).length > 0) throw new HostError('HOST_CONFIG_INVALID', 'domain-recovery-requires-host-v2')
  if (spec.schemaVersion !== 1 && Object.keys(options.supersedes ?? {}).length > 0) throw new HostError('HOST_CONFIG_INVALID', 'host-v2-requires-domain-supersedes')
  const clock = options.clock ?? systemClock
  const lock = await acquireHostStorageLock(spec.storage.root, spec.hostKey)
  const backend = new FileSessionBackend({ root: lock.root, maxRecordBytes: spec.storage.maxRecordBytes })
  const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog,
    maxLineageDepth: spec.storage.maxLineageDepth, clock })
  try {
    if (spec.schemaVersion === 3) {
      const inventory = await scanHostInventory(spec, repository)
      discoverHostWorkflows(spec, inventory, true)
      validateWorkflowCausality(inventory)
      return await recoverHostDelegations(spec, repository, options, clock, inventory)
    }
    if (spec.schemaVersion === 2) return await recoverHostDelegations(spec, repository, options, clock)
    await discoverHostDelegations(spec, repository)
    const results = []
    for (const member of spec.members.filter(isLocalHostMember)) {
      const session = await repository.open(parseSessionId(member.sessionId))
      try {
        validateHostMemberSession(session, spec.hostKey, member, { requireQuiescent: false, allowEnded: true,
          bindingVersion: 1 })
        const state = projectAgentSession(session.snapshot())
        const supersedes = options.supersedes?.[member.agentKey] ?? null
        if (supersedes !== state.openRecovery) throw new HostError('HOST_RECOVERY_REQUIRED', 'recovery-supersedes-mismatch')
        const result = await recoverAgentSession(session, { predecessorStopped: options.predecessorStopped,
          supersedes, maxRecoveryWrites: options.maxRecoveryWrites,
          maxJournalConflicts: options.maxJournalConflicts, clock })
        results.push(Object.freeze({ agentKey: member.agentKey, sessionId: member.sessionId, result }))
      } finally { await session.dispose() }
    }
    return Object.freeze(results)
  } finally {
    await repository.dispose()
    await lock.dispose()
  }
}

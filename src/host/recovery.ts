import type { Clock } from '../foundation/clock.js'
import { systemClock } from '../foundation/clock.js'
import { projectAgentSession } from '../agent/projection.js'
import { recoverAgentSession } from '../agent/recovery.js'
import { FileSessionBackend } from '../session/file-backend.js'
import { parseSessionId } from '../session/ids.js'
import { SessionRepository } from '../session/repository.js'
import { isLocalHostMember } from './config.js'
import type { ResolvedHostSpec } from './config.js'
import { validateHostMemberSession } from './binding.js'
import { hostRuntimeEventCatalog } from './initialization.js'
import { acquireHostStorageLock } from './storage-lock.js'

export interface RecoverHostOptions {
  readonly predecessorStopped: true
  readonly maxRecoveryWrites: number
  readonly maxJournalConflicts: number
  readonly clock?: Clock
}

/** Reconcile interrupted local facts without loading Providers, tools, mailboxes or network listeners. */
export async function recoverHost(spec: ResolvedHostSpec, options: RecoverHostOptions) {
  const clock = options.clock ?? systemClock
  const lock = await acquireHostStorageLock(spec.storage.root, spec.hostKey)
  const backend = new FileSessionBackend({ root: lock.root, maxRecordBytes: spec.storage.maxRecordBytes })
  const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog,
    maxLineageDepth: spec.storage.maxLineageDepth, clock })
  try {
    const results = []
    for (const member of spec.members.filter(isLocalHostMember)) {
      const session = await repository.open(parseSessionId(member.sessionId))
      try {
        validateHostMemberSession(session, spec.hostKey, member, { requireQuiescent: false })
        const state = projectAgentSession(session.snapshot())
        const result = await recoverAgentSession(session, { predecessorStopped: options.predecessorStopped,
          supersedes: state.openRecovery, maxRecoveryWrites: options.maxRecoveryWrites,
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

import type { Clock } from '../foundation/clock.js'
import { systemClock } from '../foundation/clock.js'
import { projectAgentReport } from '../agent/report.js'
import { projectAgentSession } from '../agent/projection.js'
import { FileSessionBackend } from '../session/file-backend.js'
import { parseSessionId } from '../session/ids.js'
import { SessionRepository } from '../session/repository.js'
import { isLocalHostMember } from './config.js'
import type { ResolvedHostSpec } from './config.js'
import { hostRuntimeEventCatalog } from './initialization.js'
import { projectHostSession } from './session-projection.js'
import { acquireHostStorageLock } from './storage-lock.js'

export interface HostInspectionMember {
  readonly agentKey: string
  readonly sessionId: string
  readonly bindingMode: 'initialized' | 'adopted' | null
  readonly localPosition: number
  readonly lifecycle: 'active' | 'ended'
  readonly openRecovery: ReturnType<typeof projectAgentSession>['openRecovery']
  readonly report: ReturnType<typeof projectAgentReport>
}

/** Read saved Host facts under the same exclusive root ownership gate, without Providers. */
export async function inspectHost(
  spec: ResolvedHostSpec,
  options: { readonly clock?: Clock } = {},
): Promise<readonly HostInspectionMember[]> {
  const lock = await acquireHostStorageLock(spec.storage.root, spec.hostKey)
  const backend = new FileSessionBackend({ root: lock.root, maxRecordBytes: spec.storage.maxRecordBytes })
  const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog,
    maxLineageDepth: spec.storage.maxLineageDepth, clock: options.clock ?? systemClock })
  try {
    const reports = []
    for (const member of spec.members.filter(isLocalHostMember)) {
      const snapshot = await repository.read(parseSessionId(member.sessionId))
      const binding = projectHostSession(snapshot)
      reports.push(Object.freeze({ agentKey: member.agentKey, sessionId: member.sessionId,
        bindingMode: binding.ready?.payload.mode ?? null, localPosition: snapshot.localPosition,
        lifecycle: snapshot.lifecycle, openRecovery: projectAgentSession(snapshot).openRecovery, report: projectAgentReport(snapshot) }))
    }
    return Object.freeze(reports)
  } finally {
    await repository.dispose()
    await lock.dispose()
  }
}

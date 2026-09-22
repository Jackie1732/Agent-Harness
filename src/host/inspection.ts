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
import { discoverHostDelegations } from './delegation-discovery.js'
import { delegationReport } from '../subagent/report.js'
import { effectiveResourceRelease } from '../subagent/resource-evidence.js'

export interface HostInspectionMember {
  readonly agentKey: string
  readonly sessionId: string
  readonly bindingMode: 'initialized' | 'adopted' | null
  readonly localPosition: number
  readonly lifecycle: 'active' | 'ended'
  readonly openRecovery: ReturnType<typeof projectAgentSession>['openRecovery']
  readonly report: ReturnType<typeof projectAgentReport>
}

export interface HostInspectionV2 { readonly members: readonly HostInspectionMember[]; readonly subagents: ReturnType<typeof delegationReport> }
export function inspectHost(spec: ResolvedHostSpec, options: { readonly clock?: Clock; readonly protocolVersion: 2 }): Promise<HostInspectionV2>
export function inspectHost(spec: ResolvedHostSpec, options?: { readonly clock?: Clock; readonly protocolVersion?: 1 }): Promise<readonly HostInspectionMember[]>
/** Read saved facts under exclusive root ownership; explicit v2 adds bounded public delegation state. */
export async function inspectHost(
  spec: ResolvedHostSpec,
  options: { readonly clock?: Clock; readonly protocolVersion?: 1 | 2 } = {},
): Promise<readonly HostInspectionMember[] | HostInspectionV2> {
  const lock = await acquireHostStorageLock(spec.storage.root, spec.hostKey)
  const backend = new FileSessionBackend({ root: lock.root, maxRecordBytes: spec.storage.maxRecordBytes })
  const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog,
    maxLineageDepth: spec.storage.maxLineageDepth, clock: options.clock ?? systemClock })
  try {
    const discovered = await discoverHostDelegations(spec, repository)
    const reports = []
    const parents = []
    for (const member of spec.members.filter(isLocalHostMember)) {
      const snapshot = await repository.read(parseSessionId(member.sessionId))
      const binding = projectHostSession(snapshot)
      parents.push({ parentKey: member.agentKey, snapshot })
      reports.push(Object.freeze({ agentKey: member.agentKey, sessionId: member.sessionId,
        bindingMode: binding.ready?.payload.mode ?? null, localPosition: snapshot.localPosition,
        lifecycle: snapshot.lifecycle, openRecovery: projectAgentSession(snapshot).openRecovery, report: projectAgentReport(snapshot) }))
    }
    if (options.protocolVersion !== 2) return Object.freeze(reports)
    for (const relation of discovered) {
      if (!parents.some(item => item.snapshot.header.sessionId === relation.parent.header.sessionId)) {
        parents.push({ parentKey: relation.parentKey, snapshot: relation.parent })
      }
    }
    return Object.freeze({ members: Object.freeze(reports), subagents: delegationReport(parents, spec.scheduling.maxReportEntries, id => {
      const found = discovered.find(item => item.requested.stored.eventId === id)
      const child = found?.child == null ? null : projectAgentSession(found.child)
      return { suspended: found?.closed === false, failed: false, recoveryRequired: child !== null && (child.openRun !== null || child.openRecovery !== null
        || child.subagents.resources.some(item => effectiveResourceRelease(item, child.subagents.recoveries)?.outcome !== 'released')) }
    }) })
  } finally {
    await repository.dispose()
    await lock.dispose()
  }
}

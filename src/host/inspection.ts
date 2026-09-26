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
import { hasPendingLowerExecution } from '../subagent/execution-evidence.js'
import { scanHostInventory } from './inventory.js'
import { workflowReport, workflowReportSummary } from './workflow-report.js'
import { workflowRecoveryDomains } from './workflow-recovery.js'
import { collectHostWorkflowInventory } from './workflow-discovery.js'

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
export interface HostInspectionV3 extends HostInspectionV2 {
  readonly workflows: ReturnType<typeof workflowReportSummary> & { readonly entries: ReturnType<typeof collectHostWorkflowInventory> }
  readonly recovery: { readonly domainSupersedes: Readonly<Record<string, import('../session/ids.js').SessionEventId | null>>; readonly pending: readonly string[] }
}
export function inspectHost(spec: ResolvedHostSpec, options: { readonly clock?: Clock; readonly protocolVersion: 3 }): Promise<HostInspectionV3>
export function inspectHost(spec: ResolvedHostSpec, options: { readonly clock?: Clock; readonly protocolVersion: 2 }): Promise<HostInspectionV2>
export function inspectHost(spec: ResolvedHostSpec, options?: { readonly clock?: Clock; readonly protocolVersion?: 1 }): Promise<readonly HostInspectionMember[]>
/** Read saved facts under exclusive root ownership; explicit v2 adds bounded public delegation state. */
export async function inspectHost(
  spec: ResolvedHostSpec,
  options: { readonly clock?: Clock; readonly protocolVersion?: 1 | 2 | 3 } = {},
): Promise<readonly HostInspectionMember[] | HostInspectionV2 | HostInspectionV3> {
  const lock = await acquireHostStorageLock(spec.storage.root, spec.hostKey)
  const backend = new FileSessionBackend({ root: lock.root, maxRecordBytes: spec.storage.maxRecordBytes })
  const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog,
    maxLineageDepth: spec.storage.maxLineageDepth, clock: options.clock ?? systemClock })
  try {
    const inventory = await scanHostInventory(spec, repository)
    const discovered = await discoverHostDelegations(spec, repository, inventory)
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
    if (options.protocolVersion === undefined || options.protocolVersion === 1) return Object.freeze(reports)
    for (const relation of discovered) {
      if (!parents.some(item => item.snapshot.header.sessionId === relation.parent.header.sessionId)) {
        parents.push({ parentKey: relation.parentKey, snapshot: relation.parent })
      }
    }
    const result: HostInspectionV2 = Object.freeze({ members: Object.freeze(reports), subagents: delegationReport(parents, spec.scheduling.maxReportEntries, id => {
      const found = discovered.find(item => item.requested.stored.eventId === id)
      const child = found?.child == null ? null : projectAgentSession(found.child)
      return { suspended: found?.closed === false, failed: false, recoveryRequired: child !== null && (child.openRun !== null || child.openRecovery !== null
        || child.subagents.resources.some(item => effectiveResourceRelease(item, child.subagents.recoveries)?.outcome !== 'released')) }
    }) })
    if (options.protocolVersion === 2) return result
    const entries = collectHostWorkflowInventory(inventory).filter(item => item.hostKey === spec.hostKey)
    const peers = inventory.filter(handle => !entries.some(entry => entry.sessionId === handle.header.sessionId))
    const summaries = entries.filter(entry => entry.state === 'ready').map(entry => workflowReport(inventory.find(handle => handle.header.sessionId === entry.sessionId)!, peers, false))
    const domainSupersedes = Object.fromEntries(workflowRecoveryDomains(inventory)), pending: string[] = []
    for (const snapshot of inventory) {
      if (snapshot.localPosition === 0 || entries.some(entry => entry.sessionId === snapshot.header.sessionId)) continue
      const state = projectAgentSession(snapshot), key = 'agent:' + snapshot.header.address
      const relations = discovered.filter(item => !item.closed && (item.parent.header.sessionId === snapshot.header.sessionId || item.child?.header.sessionId === snapshot.header.sessionId))
      if (!spec.members.some(member => member.kind === 'local' && member.sessionId === snapshot.header.sessionId) && relations.length === 0) continue
      domainSupersedes[key] = state.openRecovery
      if (state.openRun !== null || state.openRecovery !== null || state.controls.some(item => item.settled === null && item.supersededBy === null)
        || hasPendingLowerExecution(snapshot.history.at(-1)!.events.filter(item => item.kind === 'known'))) pending.push(key)
      for (const relation of relations) {
        const id = relation.requested.stored.eventId
        domainSupersedes['subagent:' + snapshot.header.address + ':' + id] = state.subagents.recoveries.find(item => item.requested.payload.delegation === id
          && item.settled === null && item.supersededBy === null)?.requested.stored.eventId ?? null
      }
    }
    for (const [key, value] of Object.entries(domainSupersedes)) if (value !== null && !pending.includes(key)) pending.push(key)
    const planned = entries.filter(entry => entry.state === 'planned')
    pending.push(...planned.map(entry => 'workflow-initialization:' + entry.sessionId))
    const summary = workflowReportSummary(summaries, spec.scheduling.maxReportEntries)
    return Object.freeze({ ...result, workflows: { ...summary, unclosed: summary.unclosed + planned.length, blocked: summary.blocked + planned.length,
      count: entries.length, entries: entries.slice(0, spec.scheduling.maxReportEntries),
      truncated: entries.length > spec.scheduling.maxReportEntries || summaries.some(item => item.truncated) },
      recovery: { domainSupersedes, pending } })
  } finally {
    await repository.dispose()
    await lock.dispose()
  }
}

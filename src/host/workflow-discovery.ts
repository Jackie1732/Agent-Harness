import type { SessionSnapshot } from '../session/types.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject } from '../foundation/json.js'
import type { ResolvedHostSpec } from './config.js'
import { HostError } from './errors.js'
import { projectHostWorkflowSession } from './workflow-binding.js'

export interface HostWorkflowInventoryEntry {
  readonly workflowKey: string
  readonly sessionId: string
  readonly hostKey: string
  readonly state: 'planned' | 'ready'
  readonly localPosition: number
  readonly lifecycle: 'active' | 'ended'
}

/** Retain incomplete coordinator bindings in read-only inventory. */
export function collectHostWorkflowInventory(snapshots: readonly SessionSnapshot[]): readonly HostWorkflowInventoryEntry[] {
  const found: HostWorkflowInventoryEntry[] = []
  for (const snapshot of snapshots) {
    if (!snapshot.history.at(-1)?.events.some(record => record.stored.type === 'host/session-planned'
      && record.stored.payloadVersion === 2)) continue
    const binding = projectHostWorkflowSession(snapshot)
    if (binding.planned === null) continue
    found.push({ workflowKey: binding.planned.payload.workflowKey, sessionId: snapshot.header.sessionId,
      hostKey: binding.planned.payload.hostKey, state: binding.ready === null ? 'planned' : 'ready',
      localPosition: snapshot.localPosition, lifecycle: snapshot.lifecycle })
  }
  return found.sort((a, b) => a.workflowKey.localeCompare(b.workflowKey) || a.sessionId.localeCompare(b.sessionId))
}

/** Match every durable coordinator to the current v3 recipe or require recovery. */
export function discoverHostWorkflows(spec: ResolvedHostSpec, snapshots: readonly SessionSnapshot[]): void {
  const configured = spec.schemaVersion === 3 && spec.workflows.kind === 'enabled' ? spec.workflows.definitions : []
  const found = new Set<string>()
  for (const snapshot of snapshots) {
    if (!snapshot.history.at(-1)?.events.some(record => record.stored.type === 'host/session-planned'
      && record.stored.payloadVersion === 2)) continue
    const binding = projectHostWorkflowSession(snapshot)
    if (binding.planned?.payload.hostKey !== spec.hostKey) continue
    const entry = configured.find(item => item.sessionId === snapshot.header.sessionId)
    if (entry === undefined) throw new HostError('HOST_RECOVERY_REQUIRED', 'workflow-config-removed')
    if (binding.ready === null) throw new HostError('HOST_RECOVERY_REQUIRED', 'workflow-initialization-incomplete')
    if (binding.definition === null || Buffer.compare(canonicalJsonBytes(binding.definition.payload as unknown as JsonObject),
      canonicalJsonBytes(entry.definition)) !== 0) {
      throw new HostError('HOST_BINDING_CONFLICT', 'workflow-config-changed')
    }
    found.add(snapshot.header.sessionId)
  }
  for (const entry of configured) if (!found.has(entry.sessionId!)) {
    throw new HostError('HOST_NOT_READY', 'workflow-session-missing')
  }
}

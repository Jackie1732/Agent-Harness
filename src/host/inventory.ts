import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionRepository } from '../session/repository.js'
import { parseSessionId } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import type { ResolvedHostSpec } from './config.js'
import { HostError } from './errors.js'

/** Read one bounded inventory of managed Session roots before domain assembly. */
export async function scanHostInventory(spec: ResolvedHostSpec, repository: SessionRepository): Promise<readonly SessionSnapshot[]> {
  let maximum = spec.schemaVersion !== 1 && spec.subagents.kind === 'enabled'
    ? spec.subagents.limits.maxDiscoveryEntries : 10000
  if (spec.schemaVersion === 3 && spec.workflows.kind === 'enabled') maximum = Math.min(maximum, spec.workflows.maxInventorySessions)
  const snapshots: SessionSnapshot[] = []
  const directory = await opendir(join(spec.storage.root, 'sessions'))
  let entries = 0
  for await (const entry of directory) {
    if (++entries > maximum) throw new HostError('HOST_RECOVERY_REQUIRED', 'host-inventory-limit')
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(entry.name)) continue
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new HostError('HOST_BINDING_CONFLICT', 'session-discovery-entry')
    snapshots.push(await repository.read(parseSessionId(entry.name)))
  }
  return snapshots
}

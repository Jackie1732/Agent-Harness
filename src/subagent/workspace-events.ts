import { array, eventId, exact, integer, record, text, timestamp, unique } from '../agent/validation.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { parseSessionAddress } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import type { DelegationIdentity } from './event-contract.js'
import type { WorkspaceBaseline } from './workspace.js'
import { workspaceRelativePath } from '../tool/workspace-path.js'

export type WorkspaceBaselineRecorded = DelegationIdentity & { readonly execution: SessionEventId; readonly baseline: WorkspaceBaseline }
export const workspaceBaselineRecordedEvent = createDurableEventDefinition({ type: 'subagent/workspace-baseline', payloadVersion: 1, ignorable: false,
  decode(value): WorkspaceBaselineRecorded {
    const p = record(value); exact(p, ['delegation', 'parentAddress', 'childAddress', 'execution', 'baseline'])
    eventId(p.delegation); eventId(p.execution); parseSessionAddress(text(p.parentAddress)); parseSessionAddress(text(p.childAddress))
    const baseline = record(p.baseline); exact(baseline, ['kind', 'resourceId', 'rootIdentity', 'observedAt', 'entries'])
    if (baseline.kind !== 'checked-files') throw new TypeError('baseline kind')
    text(baseline.resourceId, 128); timestamp(baseline.observedAt)
    const identity = record(baseline.rootIdentity); exact(identity, ['device', 'inode'])
    for (const value of Object.values(identity)) if (!/^[0-9]+$/.test(text(value, 64))) throw new TypeError('root identity')
    unique(array(baseline.entries, 10000).map(value => {
      const entry = record(value); exact(entry, ['path', 'byteLength', 'sha256']); integer(entry.byteLength)
      if (!/^[a-f0-9]{64}$/.test(text(entry.sha256, 64))) throw new TypeError('baseline hash')
      return workspaceRelativePath(entry.path, 4096).toLowerCase()
    }))
    return p as WorkspaceBaselineRecorded
  },
})

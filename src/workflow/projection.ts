import type { SessionSnapshot, StoredSessionEvent } from '../session/types.js'
import { invalidHistory } from './errors.js'
import { workflowDefinitionRecordedEvent, workflowNodeResolvedEvent } from './session-events.js'
import type { WorkflowDefinition } from './types.js'
import type { WorkflowNodeResolved } from './session-events.js'

export interface WorkflowSnapshot {
  readonly definition: { readonly stored: StoredSessionEvent; readonly payload: WorkflowDefinition } | null
  readonly ready: readonly string[]
  readonly resolved: readonly WorkflowNodeResolved[]
}

/** Rebuild the coordinator's admitted definition and initially ready work. */
export function projectWorkflowSession(snapshot: SessionSnapshot): WorkflowSnapshot {
  if (snapshot.header.parent !== undefined) invalidHistory('coordinator-fork')
  const local = snapshot.history.at(-1)
  if (local?.header.sessionId !== snapshot.header.sessionId) invalidHistory('coordinator-history')
  let definition: WorkflowSnapshot['definition'] = null
  const resolved = new Map<string, WorkflowNodeResolved>()
  for (const record of local.events) {
    if (record.kind !== 'known') continue
    if (record.stored.type === workflowDefinitionRecordedEvent.type) {
      if (record.stored.payloadVersion !== 1 || definition !== null || resolved.size) invalidHistory('definition-duplicate-or-version')
      const payload = workflowDefinitionRecordedEvent.decode(record.payload)
      const value = payload.definition as unknown as WorkflowDefinition
      if (value.coordinator !== snapshot.header.address) invalidHistory('coordinator-address')
      definition = { ...record, payload: value }
    } else if (record.stored.type === workflowNodeResolvedEvent.type) {
      if (record.stored.payloadVersion !== 1 || definition === null) invalidHistory('resolution-before-definition')
      const payload = workflowNodeResolvedEvent.decode(record.payload)
      if (payload.definition !== definition.stored.eventId || resolved.has(payload.nodeKey)
        || !definition.payload.nodes.some(node => node.nodeKey === payload.nodeKey)) invalidHistory('resolution-conflict')
      resolved.set(payload.nodeKey, payload)
    }
  }
  return Object.freeze({ definition,
    ready: definition?.payload.nodes.filter(node => node.dependencies.length === 0 && !resolved.has(node.nodeKey))
      .map(node => node.nodeKey) ?? [], resolved: Object.freeze([...resolved.values()]) })
}

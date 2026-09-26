import type { CommittedSessionEvent, SessionSnapshot } from '../session/types.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject } from '../foundation/json.js'
import type { WorkflowDefinition } from '../workflow/types.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import type { HostWorkflowPlanned, HostWorkflowReady } from './session-events.js'
import { hostSessionPlannedV2Event, hostSessionReadyV2Event } from './session-events.js'
import { HostError } from './errors.js'

/** Coordinator-only binding and its exact required definition source. */
export interface HostWorkflowBinding {
  readonly planned: CommittedSessionEvent<HostWorkflowPlanned> | null
  readonly definition: { readonly stored: CommittedSessionEvent['stored']; readonly payload: WorkflowDefinition } | null
  readonly ready: CommittedSessionEvent<HostWorkflowReady> | null
}
function conflict(reason: string): never { throw new HostError('HOST_BINDING_CONFLICT', reason) }

/** Classify a durable Host root before the Agent and Workflow projectors diverge. */
export function hasWorkflowBinding(snapshot: SessionSnapshot): boolean {
  return snapshot.history.at(-1)?.events.some(record => record.kind === 'known'
    && record.stored.type === 'host/session-planned' && record.stored.payloadVersion === 2
    && (record.payload as { kind?: string }).kind === 'workflow') ?? false
}

/** Read a coordinator's ordered initialization prefix without opening execution resources. */
export function projectHostWorkflowSession(snapshot: SessionSnapshot): HostWorkflowBinding {
  if (snapshot.header.parent !== undefined) conflict('workflow-fork')
  const local = snapshot.history.at(-1)
  if (local?.header.sessionId !== snapshot.header.sessionId) conflict('workflow-history')
  let planned: HostWorkflowBinding['planned'] = null
  let ready: HostWorkflowBinding['ready'] = null
  const definition = projectWorkflowSession(snapshot).definition
  for (const record of local.events) {
    if (record.kind !== 'known') continue
    if (record.stored.type === hostSessionPlannedV2Event.type) {
      if (record.stored.payloadVersion !== 2 || planned !== null || ready !== null) conflict('workflow-plan-order')
      const payload = hostSessionPlannedV2Event.decode(record.payload)
      if (payload.kind !== 'workflow') conflict('workflow-plan-kind')
      planned = { ...record, payload }
    } else if (record.stored.type === hostSessionReadyV2Event.type) {
      if (record.stored.payloadVersion !== 2 || ready !== null || planned === null) conflict('workflow-ready-order')
      const payload = hostSessionReadyV2Event.decode(record.payload)
      if (payload.kind !== 'workflow') conflict('workflow-ready-kind')
      if (definition === null || payload.through !== record.stored.sequence - 1
        || payload.planned !== planned.stored.eventId || payload.definition !== definition.stored.eventId
        || payload.hostKey !== planned.payload.hostKey || payload.workflowKey !== planned.payload.workflowKey) {
        conflict('workflow-ready-source')
      }
      ready = { ...record, payload }
    }
  }
  if (definition !== null && planned === null) conflict('workflow-definition-unplanned')
  if (planned !== null && definition !== null && (definition.stored.sequence <= planned.stored.sequence
    || definition.payload.workflowKey !== planned.payload.workflowKey
    || Buffer.compare(canonicalJsonBytes(definition.payload as unknown as JsonObject),
      canonicalJsonBytes(planned.payload.recipe.definition as JsonObject)) !== 0)) {
    conflict('workflow-definition-recipe')
  }
  return Object.freeze({ planned, definition, ready })
}

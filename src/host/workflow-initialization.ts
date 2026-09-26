import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject } from '../foundation/json.js'
import { encodeStoredSessionEvent } from '../session/codec.js'
import { SessionError } from '../session/errors.js'
import { formatSessionEventId, parseSessionAddress, sessionSequence } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { StoredSessionEvent } from '../session/types.js'
import { SESSION_ENVELOPE_VERSION } from '../session/types.js'
import type { SessionRepository } from '../session/repository.js'
import { workflowDefinitionRecordedEvent } from '../workflow/session-events.js'
import type { WorkflowDefinition } from '../workflow/types.js'
import { HostError } from './errors.js'
import { fingerprintHostRecipe, hostWorkflowPlannedEvent, hostWorkflowReadyEvent } from './session-events.js'
import { projectHostWorkflowSession } from './workflow-binding.js'

export interface HostWorkflowInitializationResult {
  readonly kind: 'workflow'
  readonly workflowKey: string
  readonly sessionId: string
  readonly mode: 'initialized' | 'existing'
  readonly readyEventId: SessionEventId
}
function conflict(reason: string): never { throw new HostError('HOST_BINDING_CONFLICT', reason) }
function same(a: JsonObject, b: JsonObject): boolean {
  return Buffer.compare(canonicalJsonBytes(a), canonicalJsonBytes(b)) === 0
}

/** Check all three initialization records before creating a coordinator Header. */
export function preflightWorkflowInitialization(hostKey: string, definition: WorkflowDefinition, maximum: number): void {
  const sessionId = parseSessionAddress(definition.coordinator)
  const recipe = { definition: definition as unknown as JsonObject }
  const fingerprint = fingerprintHostRecipe(recipe)
  const values = [
    [hostWorkflowPlannedEvent, hostWorkflowPlannedEvent.decode({ hostKey, kind: 'workflow', workflowKey: definition.workflowKey,
      recipe, fingerprint })],
    [workflowDefinitionRecordedEvent, workflowDefinitionRecordedEvent.decode({ definition: recipe.definition })],
    [hostWorkflowReadyEvent, hostWorkflowReadyEvent.decode({ hostKey, kind: 'workflow', workflowKey: definition.workflowKey,
      mode: 'initialized', planned: formatSessionEventId(sessionId, sessionSequence(1)),
      definition: formatSessionEventId(sessionId, sessionSequence(2)), through: 2 })],
  ] as const
  values.forEach(([event, payload], index) => {
    const sequence = sessionSequence(index + 1)
    const stored: StoredSessionEvent = { envelopeVersion: SESSION_ENVELOPE_VERSION, sessionId,
      eventId: formatSessionEventId(sessionId, sequence), sequence, recordedAt: '9999-12-31T23:59:59.999Z',
      type: event.type, payloadVersion: event.payloadVersion, payload }
    if (encodeStoredSessionEvent(stored).byteLength > maximum) {
      throw new HostError('HOST_CONFIG_INVALID', 'workflow-initialization-record-too-large')
    }
  })
}

/** Create or resume one exact coordinator binding without starting business execution. */
export async function initializeWorkflowCoordinator(repository: SessionRepository, hostKey: string,
  definition: WorkflowDefinition, maximum: number, resume = false): Promise<HostWorkflowInitializationResult> {
  preflightWorkflowInitialization(hostKey, definition, maximum)
  const sessionId = parseSessionAddress(definition.coordinator)
  let session: SessionHandle
  let created = false
  try { session = await repository.create({ sessionId }); created = true }
  catch (cause) {
    if (!(cause instanceof SessionError) || cause.code !== 'SESSION_ALREADY_EXISTS') throw cause
    session = await repository.open(sessionId)
  }
  try {
    const recipe = { definition: definition as unknown as JsonObject }
    const fingerprint = fingerprintHostRecipe(recipe)
    let binding = projectHostWorkflowSession(session.snapshot())
    if (binding.ready !== null) {
      if (binding.planned?.payload.hostKey !== hostKey || binding.planned.payload.fingerprint !== fingerprint
        || !same(binding.planned.payload.recipe, recipe)) conflict('workflow-ready-recipe')
      return { kind: 'workflow', workflowKey: definition.workflowKey, sessionId, mode: 'existing', readyEventId: binding.ready.stored.eventId }
    }
    if (binding.planned === null) {
      if (!created) throw new HostError('HOST_BOOTSTRAP_AMBIGUOUS', 'workflow-header-unbound')
      await session.append(hostWorkflowPlannedEvent, { hostKey, kind: 'workflow', workflowKey: definition.workflowKey,
        recipe, fingerprint })
      binding = projectHostWorkflowSession(session.snapshot())
    } else if (binding.planned.payload.hostKey !== hostKey || binding.planned.payload.fingerprint !== fingerprint
      || !same(binding.planned.payload.recipe, recipe)) conflict('workflow-plan-recipe')
    else if (!resume) throw new HostError('HOST_RECOVERY_REQUIRED', 'workflow-initialization-prefix-requires-resume')
    const local = session.snapshot().history.at(-1)!.events
    const allowed = ['host/session-planned', 'workflow/definition-recorded']
    if (local.some((event, index) => event.kind !== 'known' || event.stored.type !== allowed[index]
      || event.stored.payloadVersion !== (index === 0 ? 2 : 1))) conflict('workflow-initialization-prefix')
    if (binding.definition === null) {
      await session.append(workflowDefinitionRecordedEvent, { definition: recipe.definition })
      binding = projectHostWorkflowSession(session.snapshot())
    }
    const ready = await session.append(hostWorkflowReadyEvent, { hostKey, kind: 'workflow',
      workflowKey: definition.workflowKey, mode: 'initialized', planned: binding.planned!.stored.eventId,
      definition: binding.definition!.stored.eventId, through: session.snapshot().localPosition })
    return { kind: 'workflow', workflowKey: definition.workflowKey, sessionId, mode: 'initialized', readyEventId: ready.stored.eventId }
  } finally { await session.dispose() }
}

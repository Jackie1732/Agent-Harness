import { createDurableEventDefinition } from '../session/event-catalog.js'
import { eventId, exact, integer, nullableId, record } from '../agent/validation.js'
import { workflowReference } from './work-binding.js'
import { invalidHistory } from './errors.js'

function owner(value: ReturnType<typeof record>) {
  if (value.predecessorStopped !== true) invalidHistory('workflow-recovery-stop-required')
  return { through: integer(value.through), predecessorStopped: true as const, supersedes: nullableId(value.supersedes), maxWrites: integer(value.maxWrites, 2) }
}
export const workRecoveryRequestedEvent = createDurableEventDefinition({ type: 'work/recovery-requested', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'accepted', 'through', 'predecessorStopped', 'supersedes', 'maxWrites'])
    return { assignment: workflowReference(p.assignment), accepted: eventId(p.accepted), ...owner(p) }
  } })
export const workflowRecoveryRequestedEvent = createDurableEventDefinition({ type: 'workflow/recovery-requested', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['definition', 'through', 'predecessorStopped', 'supersedes', 'maxWrites'])
    return { definition: eventId(p.definition), ...owner(p) }
  } })
function settled(value: import('../foundation/json.js').JsonValue) {
  const p = record(value); exact(p, ['recovery', 'writes'])
  return { recovery: eventId(p.recovery), writes: integer(p.writes, 2) }
}
export const workRecoverySettledEvent = createDurableEventDefinition({ type: 'work/recovery-settled', payloadVersion: 1, ignorable: false, decode: settled })
export const workflowRecoverySettledEvent = createDurableEventDefinition({ type: 'workflow/recovery-settled', payloadVersion: 1, ignorable: false, decode: settled })
export const workflowRecoveryEventDefinitions = [workRecoveryRequestedEvent, workRecoverySettledEvent, workflowRecoveryRequestedEvent, workflowRecoverySettledEvent] as const

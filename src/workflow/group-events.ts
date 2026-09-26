import { actionReference } from '../agent/input-codec.js'
import { array, choice, eventId, exact, integer, record, text, timestamp } from '../agent/validation.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { createMessageDefinition } from '../communication/message-catalog.js'
import { workflowReference } from './work-binding.js'
import { workflowInteractionAdmittedEvent } from './interaction-events.js'
import { invalidHistory } from './errors.js'

export const workGroupRequestedEvent = createDurableEventDefinition({ type: 'work/group-requested', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'accepted', 'root', 'action', 'targetNodeKeys', 'text', 'completion', 'observedAt', 'deadline'])
    return { assignment: workflowReference(p.assignment), accepted: eventId(p.accepted), root: eventId(p.root), action: actionReference(p.action),
      targetNodeKeys: array(p.targetNodeKeys, 64).map(key => text(key, 128)), text: text(p.text, 4 * 1024 * 1024),
      completion: choice(p.completion, ['all-delivered', 'collect-outcomes']), observedAt: timestamp(p.observedAt), deadline: timestamp(p.deadline) }
  } })

export const workGroupResolvedEvent = createDurableEventDefinition({ type: 'work/group-resolved', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value), outcome = choice(p.outcome, ['admitted', 'blocked'])
    if (outcome === 'blocked') {
      exact(p, ['request', 'outcome', 'reason'])
      return { request: eventId(p.request), outcome, reason: text(p.reason, 128) }
    }
    exact(p, ['request', 'outcome', 'admission', 'value'])
    const admission = workflowInteractionAdmittedEvent.decode(p.value!)
    if (admission.kind !== 'group') invalidHistory('group-admission-kind')
    return { request: eventId(p.request), outcome, admission: workflowReference(p.admission), value: admission }
  } })

export const workflowGroupMessage = createMessageDefinition({ type: 'workflow/group', payloadVersion: 1,
  decode(value) {
    const p = record(value); exact(p, ['definition', 'assignment', 'targetAssignment', 'interaction', 'group', 'index', 'deadline', 'text'])
    return { definition: workflowReference(p.definition), assignment: workflowReference(p.assignment), targetAssignment: workflowReference(p.targetAssignment),
      interaction: workflowReference(p.interaction), group: workflowReference(p.group), index: integer(p.index, 0, 63), deadline: timestamp(p.deadline), text: text(p.text, 4 * 1024 * 1024) }
  } })

export const workGroupResultEvent = createDurableEventDefinition({ type: 'work/group-result', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['request', 'interaction', 'observedAt', 'outcome', 'recipients'])
    return { request: eventId(p.request), interaction: workflowReference(p.interaction), observedAt: timestamp(p.observedAt),
      outcome: choice(p.outcome, ['completed', 'failed', 'cancelled', 'timed-out']), recipients: array(p.recipients, 64).map(value => {
        const item = record(value); exact(item, ['assignment', 'status', 'source'])
        return { assignment: workflowReference(item.assignment), status: choice(item.status, ['delivered', 'rejected', 'abandoned', 'outcome-unknown']), source: eventId(item.source) }
      }) }
  } })

export const workGroupEventDefinitions = [workGroupRequestedEvent, workGroupResolvedEvent, workGroupResultEvent] as const

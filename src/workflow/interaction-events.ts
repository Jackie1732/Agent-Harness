import { actionReference } from '../agent/input-codec.js'
import { array, choice, eventId, exact, record, text, timestamp } from '../agent/validation.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { createMessageDefinition } from '../communication/message-catalog.js'
import { parseMessageId } from '../communication/ids.js'
import { workflowReference } from './work-binding.js'
import { invalidHistory } from './errors.js'

export const workQuestionRequestedEvent = createDurableEventDefinition({ type: 'work/interaction-requested', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['kind', 'assignment', 'accepted', 'root', 'action', 'targetNodeKey', 'text', 'observedAt', 'deadline'])
    return { kind: choice(p.kind, ['question'] as const), assignment: workflowReference(p.assignment), accepted: eventId(p.accepted), root: eventId(p.root),
      action: actionReference(p.action), targetNodeKey: text(p.targetNodeKey, 128), text: text(p.text, 4 * 1024 * 1024),
      observedAt: timestamp(p.observedAt), deadline: timestamp(p.deadline) }
  } })

export const workflowInteractionAdmittedEvent = createDurableEventDefinition({ type: 'workflow/interaction-admitted', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value), kind = choice(p.kind, ['question', 'group'])
    exact(p, ['kind', 'definition', 'assignment', 'request', kind === 'question' ? 'targetAssignment' : 'targets', 'observedAt', 'deadline'])
    const common = { definition: eventId(p.definition), assignment: workflowReference(p.assignment), request: workflowReference(p.request),
      observedAt: timestamp(p.observedAt), deadline: timestamp(p.deadline) }
    if (kind === 'question') return { ...common, kind, targetAssignment: workflowReference(p.targetAssignment) }
    return { ...common, kind, targets: array(p.targets, 64).map(value => {
      const target = record(value); exact(target, ['nodeKey', 'assignment'])
      return { nodeKey: text(target.nodeKey, 128), assignment: workflowReference(target.assignment) }
    }) }
  } })

export const workInteractionResolvedEvent = createDurableEventDefinition({ type: 'work/interaction-resolved', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value)
    const outcome = choice(p.outcome, ['admitted', 'blocked'])
    if (outcome === 'admitted') {
      exact(p, ['request', 'outcome', 'admission', 'value'])
      const admitted = workflowInteractionAdmittedEvent.decode(p.value!)
      if (admitted.kind !== 'question') invalidHistory('question-admission-kind')
      return { request: eventId(p.request), outcome, admission: workflowReference(p.admission), value: admitted }
    }
    exact(p, ['request', 'outcome', 'reason', 'cycle'])
    return { request: eventId(p.request), outcome, reason: text(p.reason, 128), cycle: array(p.cycle).map(workflowReference) }
  } })

export const workflowInteractionSettledEvent = createDurableEventDefinition({ type: 'workflow/interaction-settled', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['interaction', 'outcome', 'source'])
    return { interaction: eventId(p.interaction), outcome: choice(p.outcome, ['answered', 'declined', 'completed', 'failed', 'timed-out', 'cancelled', 'interrupted']), source: workflowReference(p.source) }
  } })

export const workflowQuestionMessage = createMessageDefinition({ type: 'workflow/question', payloadVersion: 1,
  decode(value) {
    const p = record(value); exact(p, ['definition', 'assignment', 'targetAssignment', 'interaction', 'question', 'deadline', 'text'])
    return { definition: workflowReference(p.definition), assignment: workflowReference(p.assignment), targetAssignment: workflowReference(p.targetAssignment),
      interaction: workflowReference(p.interaction), question: workflowReference(p.question), deadline: timestamp(p.deadline), text: text(p.text, 4 * 1024 * 1024) }
  } })

export const workflowAnswerMessage = createMessageDefinition({ type: 'workflow/answer', payloadVersion: 1,
  decode(value) {
    const p = record(value); exact(p, ['definition', 'assignment', 'targetAssignment', 'interaction', 'question', 'questionMessageId', 'outcome', 'text'])
    return { definition: workflowReference(p.definition), assignment: workflowReference(p.assignment), targetAssignment: workflowReference(p.targetAssignment),
      interaction: workflowReference(p.interaction), question: workflowReference(p.question), questionMessageId: parseMessageId(text(p.questionMessageId)),
      outcome: choice(p.outcome, ['answered', 'declined', 'unavailable']), text: text(p.text, 4 * 1024 * 1024) }
  } })

export const workProtocolClassifiedEvent = createDurableEventDefinition({ type: 'work/protocol-classified', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['accepted', 'inbox', 'kind', 'classification'])
    return { accepted: eventId(p.accepted), inbox: eventId(p.inbox), kind: choice(p.kind, ['question', 'answer', 'group'] as const),
      classification: choice(p.classification, ['eligible', 'late', 'duplicate']) }
  } })

export const workQuestionDeclinedEvent = createDurableEventDefinition({ type: 'work/question-declined', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['accepted', 'inbox', 'reason', 'observedAt'])
    return { accepted: eventId(p.accepted), inbox: eventId(p.inbox), reason: choice(p.reason, ['question-expired', 'work-root-terminal', 'work-answer-unavailable'] as const), observedAt: timestamp(p.observedAt) }
  } })

export const workInteractionEventDefinitions = [workQuestionRequestedEvent, workInteractionResolvedEvent, workProtocolClassifiedEvent, workQuestionDeclinedEvent] as const

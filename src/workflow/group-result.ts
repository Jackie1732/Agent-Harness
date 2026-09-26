import type { AgentProjectionState } from '../agent/projection-state.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
import { formatSessionAddress } from '../session/ids.js'
import { projectCommunicationEvents } from '../communication/projection.js'
import { workGroupRequestedEvent, workGroupResolvedEvent, workGroupResultEvent } from './group-events.js'
import { sameWorkflowValue } from './work-binding.js'
import { invalidHistory } from './errors.js'
import { inputKey } from '../agent/input-codec.js'

/** A vector is derived from original indexed Outbox facts; an unconfirmed attempt remains unknown. */
export function workGroupResult(state: AgentProjectionState, requestId: SessionEventId, observedAt: string): ReturnType<typeof workGroupResultEvent.decode> | undefined {
  const source = state.sources.get(requestId)!, request = workGroupRequestedEvent.decode(source.payload)
  const resolved = [...state.sources.values()].find(event => event.stored.type === workGroupResolvedEvent.type && workGroupResolvedEvent.decode(event.payload).request === requestId)
  const admission = resolved === undefined ? undefined : workGroupResolvedEvent.decode(resolved.payload)
  if (admission?.outcome !== 'admitted') return undefined
  const root = state.roots.get(request.root)!, wait = [...state.waits.values()].find(wait => sameWorkflowValue(wait.reference, request.action))
  const expired = observedAt >= admission.value.deadline
  const stopped = root.stopControl !== null || root.outcome !== null || wait?.settled != null
  const facts = projectCommunicationEvents(formatSessionAddress(source.stored.sessionId), [...state.sources.values()])
  const recipients: ReturnType<typeof workGroupResultEvent.decode>['recipients'][number][] = []
  for (const [index, target] of admission.value.targets.entries()) {
    const outgoing = facts.outbox.find(item => item.sendKey?.eventId === requestId && item.sendKey.index === index)
    if (outgoing?.status === 'pending' || outgoing === undefined && !expired && !stopped) return undefined
    const uncertain = outgoing?.status === 'abandoned' && [...state.sources.values()].some(event => {
      if (event.stored.type !== 'communication/outbox-attempt-failed') return false
      const payload = event.payload as { messageId: string; code: string }
      return payload.messageId === outgoing.messageId && ['attempt-interrupted', 'receiver-outcome-unknown', 'transport-outcome-unknown'].includes(payload.code)
    })
    recipients.push({ assignment: target.assignment, status: uncertain ? 'outcome-unknown' : outgoing?.status ?? 'abandoned',
      source: outgoing?.terminalEventId ?? requestId })
  }
  const outcome = expired ? 'timed-out' : stopped ? 'cancelled'
    : request.completion === 'all-delivered' && recipients.some(item => item.status !== 'delivered') ? 'failed' : 'completed'
  return { request: requestId, interaction: admission.admission, observedAt, outcome, recipients }
}

export function applyWorkGroupResult(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const p = workGroupResultEvent.decode(event.payload)
  const expected = workGroupResult(state, p.request, p.observedAt)
  if (expected === undefined || !sameWorkflowValue(p, expected) || [...state.sources.values()].some(item => item.stored.type === event.stored.type
    && workGroupResultEvent.decode(item.payload).request === p.request)) invalidHistory('work-group-result-source')
  const request = workGroupRequestedEvent.decode(state.sources.get(p.request)!.payload), root = state.roots.get(request.root)!
  const wait = [...state.waits.values()].find(wait => sameWorkflowValue(wait.reference, request.action))
  if (root.outcome !== null || root.stopControl !== null || wait?.settled !== null || ['cancelled', 'timed-out'].includes(p.outcome)) return
  const reference = { kind: 'workflow' as const, eventId: event.stored.eventId }
  state.inputs.set(inputKey(reference), { reference, input: null, message: null,
    workGroupResult: { assignment: request.assignment, request: p.request, interaction: p.interaction },
    acceptedAt: p.observedAt, sequence: event.stored.sequence, lane: `workflow:${request.assignment.address}`,
    status: 'queued', claimedBy: null, reservedBy: null, everMatched: false, reason: null })
}

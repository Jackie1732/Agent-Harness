import type { AgentActionReference } from '../agent/contract.js'
import type { AgentActionResult } from '../agent/event-contract.js'
import type { SessionSnapshot } from '../session/types.js'
import { workProtocolRecordedEvent } from './protocol.js'
import { sameWorkflowValue } from './work-binding.js'
import { workQuestionRequestedEvent, workInteractionResolvedEvent } from './interaction-events.js'
import { workQuestionResult } from './question-action.js'
import { foldAgentSession } from '../agent/projection.js'
import { workGroupRequestedEvent, workGroupResolvedEvent } from './group-events.js'
import { groupWaitResult } from './group-action.js'

/** Reuse a committed work action intent without invoking a Provider or sending a message. */
export function recoverWorkAction(snapshot: SessionSnapshot, action: AgentActionReference): AgentActionResult | undefined {
  const protocol = snapshot.history.at(-1)!.events.find(event => {
    if (event.kind !== 'known' || event.stored.type !== workProtocolRecordedEvent.type) return false
    const source = workProtocolRecordedEvent.decode(event.payload).source
    return typeof source !== 'string' && sameWorkflowValue(source.action, action)
  })
  if (protocol !== undefined) return { kind: 'protocol-accepted', protocol: protocol.stored.eventId }
  const state = foldAgentSession(snapshot)
  const group = [...state.sources.values()].find(event => event.stored.type === workGroupRequestedEvent.type
    && sameWorkflowValue(workGroupRequestedEvent.decode(event.payload).action, action))
  const groupResolution = [...state.sources.values()].find(event => event.stored.type === workGroupResolvedEvent.type
    && workGroupResolvedEvent.decode(event.payload).request === group?.stored.eventId)
  if (groupResolution !== undefined) return groupWaitResult(state, workGroupResolvedEvent.decode(groupResolution.payload))
  const request = [...state.sources.values()].find(event => event.stored.type === workQuestionRequestedEvent.type
    && sameWorkflowValue(workQuestionRequestedEvent.decode(event.payload).action, action))
  const resolved = [...state.sources.values()].find(event => event.stored.type === workInteractionResolvedEvent.type
    && workInteractionResolvedEvent.decode(event.payload).request === request?.stored.eventId)
  return resolved === undefined ? undefined : workQuestionResult(state, { ...resolved, payload: workInteractionResolvedEvent.decode(resolved.payload) })
}

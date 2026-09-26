import type { AgentActionReference } from '../agent/contract.js'
import type { AgentActionResult } from '../agent/event-contract.js'
import type { SessionSnapshot } from '../session/types.js'
import { workProtocolRecordedEvent } from './protocol.js'
import { sameWorkflowValue } from './work-binding.js'

/** Reuse a committed work action intent without invoking a Provider or sending a message. */
export function recoverWorkAction(snapshot: SessionSnapshot, action: AgentActionReference): AgentActionResult | undefined {
  const protocol = snapshot.history.at(-1)!.events.find(event => {
    if (event.kind !== 'known' || event.stored.type !== workProtocolRecordedEvent.type) return false
    const source = workProtocolRecordedEvent.decode(event.payload).source
    return typeof source !== 'string' && sameWorkflowValue(source.action, action)
  })
  return protocol === undefined ? undefined : { kind: 'protocol-accepted', protocol: protocol.stored.eventId }
}

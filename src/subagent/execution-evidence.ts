import type { CommittedSessionEvent } from '../session/types.js'
import { record } from '../agent/validation.js'

/** Lower-domain prepared requests remain open until their own settlement facts exist. */
export function hasPendingLowerExecution(events: Iterable<CommittedSessionEvent>): boolean {
  const pending = new Set<string>()
  for (const event of events) {
    const type = event.stored.type
    const domain = type.startsWith('model/') ? 'model:' : type.startsWith('tool/') ? 'tool:' : null
    if (domain === null) continue
    if (type === 'model/invocation-prepared' || type === 'tool/invocation-requested') pending.add(domain + record(event.payload).invocationId)
    if (type === 'model/invocation-settled' || type === 'tool/invocation-settled') pending.delete(domain + record(event.payload).invocationId)
  }
  return pending.size > 0
}

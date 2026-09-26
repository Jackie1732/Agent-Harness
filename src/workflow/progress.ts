import { eventId, exact, integer, record, text } from '../agent/validation.js'
import { createMessageDefinition } from '../communication/message-catalog.js'
import { workflowReference } from './work-binding.js'

/** Progress describes one production assignment and never acts as a candidate or acceptance. */
export const workflowProgressMessage = createMessageDefinition({ type: 'workflow/progress', payloadVersion: 1,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'root', 'ordinal', 'text'])
    return { assignment: workflowReference(p.assignment), root: eventId(p.root), ordinal: integer(p.ordinal, 1), text: text(p.text, 4 * 1024 * 1024) }
  } })

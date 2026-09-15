import type { ContextInput } from './contract.js'
import { choice, contextJson, eventId, exact, integer, record, text } from './validation.js'
import { invalidContext } from './errors.js'

export function decodeContextInput(value: unknown): ContextInput {
  const input = record(contextJson(value))
  switch (choice(input.kind, ['user', 'legacy-model-input'])) {
    case 'user':
      exact(input, ['kind', 'origin', 'originLabel', 'text'])
      choice(input.origin, ['host-authored', 'host-import']); text(input.originLabel, 128); text(input.text, 4 * 1024 * 1024)
      break
    case 'legacy-model-input':
      exact(input, ['kind', 'preparedEventId', 'fromMessage', 'toMessage'])
      eventId(input.preparedEventId)
      if (integer(input.fromMessage) >= integer(input.toMessage)) invalidContext('legacy-range')
      break
  }
  return input as ContextInput
}

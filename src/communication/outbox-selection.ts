import type { OutboxMessageSnapshot } from './types.js'

/** Channel ordering is local to one sender, recipient and Channel identity. */
export function outboxChannelKey(message: OutboxMessageSnapshot): string {
  return `${message.envelope.recipient}\u0000${message.envelope.channelId}`
}

/** Read the first pending message of each Channel from the committed acceptance order. */
export function* pendingOutboxHeads(messages: readonly OutboxMessageSnapshot[]): IterableIterator<OutboxMessageSnapshot> {
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.status !== 'pending') continue
    const key = outboxChannelKey(message)
    if (seen.has(key)) continue
    seen.add(key)
    yield message
  }
}

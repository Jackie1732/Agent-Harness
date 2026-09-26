import type { SessionHandle } from '../session/session-handle.js'
import type { SessionMailbox } from '../communication/mailbox.js'
import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import { foldAgentSession } from '../agent/projection.js'
import { AgentJournal } from '../agent/journal.js'
import { CommunicationError } from '../communication/errors.js'
import { workGroupRequestedEvent, workGroupResolvedEvent, workGroupResultEvent } from './group-events.js'
import { groupCommands } from './group-action.js'
import { workGroupResult } from './group-result.js'
import { workInteractionSendReady } from './receive.js'

/** One original keyed send, one joined abandonment, or one complete durable result vector. */
export function nextWorkGroupAction(session: SessionHandle, mailbox: SessionMailbox, clock: Clock): (() => Promise<unknown>) | undefined {
  const state = foldAgentSession(session.snapshot()), observedAt = clockTimestamp(clock)
  for (const event of state.sources.values()) {
    if (event.stored.type !== workGroupResolvedEvent.type) continue
    const resolution = workGroupResolvedEvent.decode(event.payload)
    if (resolution.outcome !== 'admitted' || [...state.sources.values()].some(item => item.stored.type === workGroupResultEvent.type
      && workGroupResultEvent.decode(item.payload).request === resolution.request)) continue
    const request = workGroupRequestedEvent.decode(state.sources.get(resolution.request)!.payload), root = state.roots.get(request.root)!
    const stopped = root.outcome !== null || root.stopControl !== null || observedAt >= resolution.value.deadline
    const outbox = mailbox.snapshot().outbox
    if (stopped) {
      const pending = outbox.find(item => item.sendKey?.eventId === resolution.request && item.status === 'pending')
      if (pending !== undefined) return async () => {
        try { await mailbox.abandonOutgoing(pending.messageId, 'caller-requested') }
        catch (cause) {
          if (!(cause instanceof CommunicationError && cause.code === 'MESSAGE_STATE_INVALID'
            && mailbox.snapshot().outbox.find(item => item.messageId === pending.messageId)?.status !== 'pending')) throw cause
        }
      }
    } else if (workInteractionSendReady(state, resolution.request, observedAt)) {
      const commands = groupCommands(state.sources, resolution.request).commands
      for (const [index, command] of commands.entries()) {
        if (!outbox.some(item => item.sendKey?.eventId === resolution.request && item.sendKey.index === index)) {
          return () => mailbox.sendOnce({ eventId: resolution.request, index }, command.request, command)
        }
      }
    }
    const result = workGroupResult(state, resolution.request, observedAt)
    if (result !== undefined) return () => new AgentJournal(session, state.spec!.payload.limits.maxJournalConflicts, clock)
      .append(workGroupResultEvent, (_state, snapshot) => workGroupResult(foldAgentSession(snapshot), resolution.request, observedAt)!)
  }
  return undefined
}

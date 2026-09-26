import { agentStopAction } from './stop-maintenance.js'
import { expireAgentRoot } from './root-policy.js'
import { clockTimestamp } from '../foundation/clock.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { AgentRuntime } from './runtime-contract.js'
import type { AgentWaitState } from './state.js'
import { projectAgentSession } from './projection.js'
import { matchesAgentWait } from './projection-controls.js'
import type { SessionSnapshot } from '../session/types.js'
import type { AgentSessionSnapshot } from './state.js'
import type { AgentWaitSettled } from './event-contract.js'
import { subagentMessageDefinitions } from '../subagent/messages.js'
import { workflowQuestionMessage, workflowAnswerMessage } from '../workflow/interaction-events.js'

function takeManagement(runtime: AgentRuntime): boolean {
  if (runtime.management === undefined) return true
  if (runtime.management.remaining === 0) return false
  runtime.management.remaining--; return true
}

/** Receipt synchronization is separate from Agent input disposition and safe to resume. */
export async function synchronizeAgentReceipts(runtime: AgentRuntime): Promise<void> {
  if (runtime.mailbox === undefined) return
  const facts = projectCommunicationFacts(runtime.session.snapshot())
  for (const input of projectAgentSession(runtime.session.snapshot()).inputs) {
    if (input.message === null || !['handled', 'abandoned'].includes(input.status)
      || facts.inbox.find(item => item.messageId === input.message!.messageId)?.status !== 'pending') continue
    if (input.status === 'handled' && runtime.mailbox.snapshot().inbox.find(item => item.messageId === input.message!.messageId)?.supported !== true) continue
    if (!takeManagement(runtime)) return
    if (input.status === 'handled') await runtime.mailbox.markProcessed(input.message.messageId)
    else await runtime.mailbox.abandonIncoming(input.message.messageId, 'caller-requested')
  }
}

export async function settleAgentStops(runtime: AgentRuntime): Promise<void> {
  while (true) {
    const action = agentStopAction(runtime.session, runtime.journal, runtime.clock)
    if (action === undefined || !takeManagement(runtime)) return
    await action()
  }
}

/** Bounded wake-time work, with event acceptance times deciding on-time responses. */
export async function manageAgentWaits(runtime: AgentRuntime): Promise<void> {
  const spec = projectAgentSession(runtime.session.snapshot()).spec!.payload
  for (const root of projectAgentSession(runtime.session.snapshot()).roots) {
    if (root.outcome === null && root.stopControl === null && clockTimestamp(runtime.clock) >= root.deadline) {
      if (!takeManagement(runtime)) return
      await expireAgentRoot(runtime, root.id)
    }
  }
  await settleAgentStops(runtime)
  for (const wait of projectAgentSession(runtime.session.snapshot()).waits) {
    if (wait.settled !== null) continue
    const state = projectAgentSession(runtime.session.snapshot())
    if (state.turns.find(turn => turn.started.stored.eventId === wait.turn)?.settled?.payload.outcome !== 'waiting') continue
    const descriptor = wait.created.payload.result.kind === 'wait' ? wait.created.payload.result.descriptor : undefined
    if (descriptor === undefined || state.roots.find(root => root.id === descriptor.root)?.stopControl !== null) continue
    const messageKinds = spec.protocolVersion === 1 ? spec.messages : [...spec.messages, ...subagentMessageDefinitions,
      ...(spec.protocolVersion === 3 ? [workflowQuestionMessage, workflowAnswerMessage] : [])]
    const supportedMessages = messageKinds.filter(kind => runtime.messageCatalog.resolve(kind.type, kind.payloadVersion) !== undefined).map(({ type, payloadVersion }) => ({ type, payloadVersion }))
    const match = findWaitResponse(runtime.session.snapshot(), state, wait, supportedMessages)
    const outgoing = descriptor.kind === 'reply' ? projectCommunicationFacts(runtime.session.snapshot()).outbox.find(item => item.acceptedEventId === descriptor.outboxEventId) : undefined
    const unavailable = outgoing !== undefined && (outgoing.status === 'abandoned' || outgoing.status === 'rejected')
    if (match !== undefined || unavailable || clockTimestamp(runtime.clock) >= descriptor.deadline) {
      if (!takeManagement(runtime)) return
      const observedAt = clockTimestamp(runtime.clock)
      await runtime.journal.append(runtime.events.waitSettled, (current, snapshot) => {
        const response = findWaitResponse(snapshot, current, wait, supportedMessages)
        const stopped = current.roots.find(root => root.id === descriptor.root)!.stopControl !== null
        return { wait: wait.reference, outcome: stopped ? 'cancelled' as const : response !== undefined ? 'matched' as const : unavailable ? 'unavailable' as const : 'timed-out' as const,
          response: stopped ? null : response?.reference ?? null, reason: stopped ? 'root-stopped' : response !== undefined ? 'response-matched' : unavailable ? 'outbound-unavailable' : 'wait-deadline',
          observedAt, supportedMessages, outboxTerminal: !stopped && response === undefined && unavailable && 'terminalEventId' in outgoing ? outgoing.terminalEventId : null }
      })
    }
  }
  await synchronizeAgentReceipts(runtime)
}

function findWaitResponse(snapshot: SessionSnapshot, state: AgentSessionSnapshot, wait: AgentWaitState, supported: AgentWaitSettled['supportedMessages']) {
  const sources = new Map(snapshot.history.at(-1)!.events.flatMap(item => item.kind === 'known' ? [[item.stored.eventId, item] as const] : []))
  const controls = new Map(state.controls.map(control => [control.requested.stored.eventId, control]))
  return state.inputs.find(input => matchesAgentWait(wait, input, { sources, controls }) && (input.message === null
    || supported.some(item => item.type === input.message!.type && item.payloadVersion === input.message!.payloadVersion)))
}

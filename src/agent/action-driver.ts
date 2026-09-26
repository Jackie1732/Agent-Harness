import { ToolError } from '../tool/errors.js'
import { SubagentError } from '../subagent/errors.js'
import { WorkflowError } from '../workflow/errors.js'
import type { AgentActionReference, AgentSendCommand } from './contract.js'
import type { AgentActionIntent, AgentActionResult } from './event-contract.js'
import type { AgentRuntime } from './runtime-contract.js'
import type { SessionEventId } from '../session/ids.js'
import { parseMessageId } from '../communication/ids.js'
import { CommunicationError } from '../communication/errors.js'
import { projectAgentSession } from './projection.js'
import { projectModelSession } from '../model/projection.js'
import { projectToolSession } from '../tool/projection.js'
import { clockTimestamp } from '../foundation/clock.js'
import { agentJson, exact, integer, record, text } from './validation.js'
import { decodeAgentCommand, inputKey } from './input-codec.js'
import { AgentError } from './errors.js'
import { resolveAgentSend } from './command.js'
import type { MessageEnvelope } from '../communication/types.js'
import { rootPeerInputs } from './obligations.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { AgentWaitDescriptor } from './contract.js'

/** Outbox identity is the durable Action, including direct command actions. */
export async function executeAgentSend(runtime: AgentRuntime, action: AgentActionReference, command: AgentSendCommand, trigger?: MessageEnvelope): Promise<AgentActionResult> {
  const spec = projectAgentSession(runtime.session.snapshot()).spec!.payload
  if (runtime.mailbox === undefined) return { kind: 'communication-not-accepted', reason: 'mailbox-unavailable', basis: 'observed-rejection' }
  try {
    const resolved = resolveAgentSend(spec, command, trigger)
    const content = { type: resolved.type, payloadVersion: resolved.payloadVersion, payload: resolved.payload }
    let accepted
    if (resolved.kind === 'send') accepted = await runtime.mailbox.sendOnce(action, resolved.request, content)
    else accepted = await runtime.mailbox.replyOnce(action, resolved.inboxMessageId, content)
    return { kind: 'outbox', accepted: accepted.outboxEventId }
  } catch (error) {
    if (runtime.session.status !== 'open' || runtime.mailbox.status !== 'open') throw new AgentError('AGENT_COMMIT_UNKNOWN', 'communication-not-confirmed')
    if (error instanceof AgentError || error instanceof CommunicationError) return { kind: 'communication-not-accepted', reason: error.code, basis: 'observed-rejection' }
    if (error instanceof SyntaxError) return { kind: 'communication-not-accepted', reason: 'payload-json-invalid', basis: 'observed-rejection' }
    throw new AgentError('AGENT_WRITE_FAILED', 'communication-unclassified-failure')
  }
}

function waitResult(runtime: AgentRuntime, descriptor: AgentWaitDescriptor): AgentActionResult {
  const result = { kind: 'wait' as const, descriptor }
  return canonicalJsonBytes(result).byteLength + 1024 > runtime.session.maxRecordBytes
    ? { kind: 'not-started', reason: 'wait-record-limit' } : result
}

/** Resolve original arguments once; only the owning lower runner may execute an ordinary Tool. */
export async function executeAgentAction(runtime: AgentRuntime, turnId: SessionEventId, action: AgentActionReference, intent: AgentActionIntent, signal: AbortSignal): Promise<AgentActionResult> {
  if (signal.aborted) return { kind: 'not-started', reason: 'cancelled-before-action' }
  const snapshot = runtime.session.snapshot()
  const state = projectAgentSession(snapshot)
  const spec = state.spec!.payload
  const turn = state.turns.find(item => item.started.stored.eventId === turnId)!
  const root = state.roots.find(item => item.id === turn.root)!
  if (root.stopControl !== null || clockTimestamp(runtime.clock) >= root.deadline) return { kind: 'not-started', reason: 'root-stopped' }
  if (intent.route === 'invalid') return { kind: 'not-started', reason: 'action-not-advertised' }
  const model = projectModelSession(snapshot).invocations.find(item => item.invocationId === intent.source.invocationId)
  const block = model?.state === 'settled' ? model.settled.payload.result.blocks.find(item => item.index === intent.source.outputBlockIndex) : undefined
  if (block?.kind !== 'tool-call') throw new AgentError('AGENT_SOURCE_INVALID', 'action-model-block')
  if (Buffer.byteLength(block.argumentsText) > spec.limits.maxActionBytes) return { kind: 'not-started', reason: 'action-arguments-limit' }
  if (intent.route === 'tool') {
    if (runtime.tools === undefined) return { kind: 'not-started', reason: 'tool-runner-unavailable' }
    try {
      const settled = await runtime.tools.invokeModelIntent(intent.source, { signal })
      return { kind: 'tool', settled: settled.stored.eventId }
    } catch (error) {
      const committed = projectToolSession(runtime.session.snapshot()).invocations.find(item => item.requested.payload.source.kind === 'model'
        && item.requested.payload.source.intent.invocationId === intent.source.invocationId && item.requested.payload.source.intent.outputBlockIndex === intent.source.outputBlockIndex)
      if (runtime.session.status === 'open' && committed?.state === 'settled') return { kind: 'tool', settled: committed.settled.stored.eventId }
      if (error instanceof ToolError && error.code === 'TOOL_RECORD_BUDGET' && committed === undefined) return { kind: 'not-started', reason: error.message }
      throw error
    }
  }
  let parsed
  try {
    parsed = record(agentJson(JSON.parse(block.argumentsText)))
    if (intent.route.startsWith('work-')) {
      if (runtime.workActions === undefined) return { kind: 'not-started', reason: 'work-capability-unavailable' }
      return await runtime.workActions.execute(turnId, action, intent, parsed, signal)
    }
    if (['spawn', 'await-subagent', 'answer-subagent', 'ask-parent', 'progress'].includes(intent.route)) {
      if (runtime.subagentActions === undefined) return { kind: 'not-started', reason: 'subagent-capability-unavailable' }
      return await runtime.subagentActions.execute(turnId, action, intent, parsed, signal)
    }
    if (intent.route === 'send' || intent.route === 'reply') {
      const command = decodeAgentCommand({ ...parsed, kind: intent.route })
      if (command.kind === 'reply') {
        if (!rootPeerInputs(turn.root, state.turns, state.inputs).some(input => input.message!.messageId === command.messageId)) throw new Error('reply-not-claimed')
      }
      const trigger = state.inputs.find(input => inputKey(input.reference) === inputKey(turn.started.payload.input))?.message ?? undefined
      return await executeAgentSend(runtime, action, command, trigger)
    }
    exact(parsed, intent.route === 'ask' ? ['question', 'timeoutMs'] : ['messageId', 'timeoutMs'])
    const timeout = integer(parsed.timeoutMs, 1, spec.limits.maxWaitMs)
    const observedAt = clockTimestamp(runtime.clock)
    const deadline = new Date(Math.min(Date.parse(observedAt) + timeout, Date.parse(root.deadline))).toISOString()
    const common = { root: root.id, deadline, observedAt, protectedTurns: state.turns.filter(item => item.root === root.id).map(item => item.started.stored.eventId) }
    if (intent.route === 'ask') return waitResult(runtime, { ...common, kind: 'user', question: text(parsed.question, spec.limits.maxResultBytes) })
    const messageId = parseMessageId(text(parsed.messageId))
    const accepted = runtime.mailbox?.snapshot().outbox.find(item => item.messageId === messageId)
    if (accepted === undefined) throw new Error('watched-outbox-missing')
    if (accepted.status === 'rejected' || accepted.status === 'abandoned') throw new Error('watched-outbox-terminal')
    const owner = state.actions.find(item => item.payload.result.kind === 'outbox' && item.payload.result.accepted === accepted.acceptedEventId)
    const ownerStep = state.steps.find(item => item.decided?.stored.eventId === owner?.payload.action.eventId)
    if (state.turns.find(item => item.started.stored.eventId === ownerStep?.opened.payload.turn)?.root !== root.id) throw new Error('watched-outbox-not-owned')
    return waitResult(runtime, { ...common, kind: 'reply', messageId, outboxEventId: accepted.acceptedEventId })
  } catch (error) {
    if (error instanceof WorkflowError) {
      if (error.code === 'WORKFLOW_COMMIT_UNKNOWN') throw new AgentError('AGENT_COMMIT_UNKNOWN', 'work-commit-unknown')
      if (error.code === 'WORKFLOW_ADMISSION_BLOCKED' || error.code === 'WORKFLOW_RESULT_INVALID') return { kind: 'not-started', reason: error.message }
      throw error
    }
    if (intent.route.startsWith('work-') && !(error instanceof AgentError) && !(error instanceof SyntaxError)) throw error
    if (error instanceof SubagentError && error.code === 'SUBAGENT_COMMIT_UNKNOWN') throw new AgentError('AGENT_COMMIT_UNKNOWN', 'subagent-commit-unknown')
    if (error instanceof AgentError && ['AGENT_COMMIT_UNKNOWN', 'AGENT_WRITE_FAILED'].includes(error.code)) throw error
    return { kind: 'not-started', reason: error instanceof SubagentError ? error.message : 'native-arguments-invalid' }
  }
}

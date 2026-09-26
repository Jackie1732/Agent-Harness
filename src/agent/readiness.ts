import { subagentMessageDefinitions } from '../subagent/messages.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { SessionSnapshot } from '../session/types.js'
import { AgentError } from './errors.js'
import { matchesAgentWait } from './projection-controls.js'
import { projectAgentSession } from './projection.js'
import { selectAgentInput } from './scheduling.js'
import { runnableAgentInputs } from './scheduling.js'
import { assertAgentExecutionQuiescent } from './execution-health.js'

export type AgentReadinessBlock =
  | 'none' | 'ended' | 'recovery-required' | 'closing' | 'driver-active'
  | 'unsupported-input' | 'review-required' | 'waiting' | 'idle' | 'cleanup-incomplete' | 'capacity'

/** Pure Host-facing observation; actual Agent operations revalidate every fact. */
export interface AgentReadiness {
  readonly sourcePosition: number
  readonly canRun: boolean
  readonly canMaintain: boolean
  readonly nextWakeAt: string | null
  readonly blockedBy: AgentReadinessBlock
  readonly counts: {
    readonly runnableInputs: number
    readonly pendingMaintenance: number
    readonly unsupportedInputs: number
    readonly reviewRequiredInputs: number
  }
}

/** Derive scheduling eligibility from one immutable committed view. */
export function inspectAgentReadiness(
  snapshot: SessionSnapshot,
  catalog: MessageCatalog,
  observedAt: string,
): AgentReadiness {
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) {
    throw new AgentError('AGENT_INPUT_INVALID', 'readiness-observed-at')
  }
  const state = projectAgentSession(snapshot)
  const communication = projectCommunicationFacts(snapshot)
  const sources = new Map(snapshot.history.at(-1)?.events.flatMap(event => event.kind === 'known'
    ? [[event.stored.eventId, event] as const] : []) ?? [])
  const controls = new Map(state.controls.map(control => [control.requested.stored.eventId, control]))
  const support = [...(state.spec?.payload.messages ?? []), ...(state.spec?.payload.protocolVersion !== 1 ? subagentMessageDefinitions : [])]
    .filter(item => catalog.resolve(item.type, item.payloadVersion) !== undefined)
  const pendingControls = state.controls.filter(item => item.settled === null && item.supersededBy === null
    && ['cancel-work', 'expire-work'].includes(item.requested.payload.kind)).length
  const pendingReceipts = state.inputs.filter(input => input.message !== null && ['handled', 'abandoned'].includes(input.status)
    && communication.inbox.some(item => item.messageId === input.message!.messageId && item.status === 'pending')).length
  const actionableWaits = state.waits.filter(wait => {
    if (wait.settled !== null || wait.created.payload.result.kind !== 'wait') return false
    const descriptor = wait.created.payload.result.descriptor
    const root = state.roots.find(item => item.id === descriptor.root)
    if (root !== undefined && root.stopControl !== null || descriptor.deadline <= observedAt) return true
    const response = state.inputs.some(input => matchesAgentWait(wait, input, { sources, controls })
      && (input.message === null || support.some(kind => kind.type === input.message!.type && kind.payloadVersion === input.message!.payloadVersion)))
    if (response) return true
    return descriptor.kind === 'reply' && communication.outbox.some(item => item.acceptedEventId === descriptor.outboxEventId
      && ['rejected', 'abandoned'].includes(item.status))
  }).length
  const dueRoots = state.roots.filter(root => root.outcome === null && root.stopControl === null && root.deadline <= observedAt).length
  const pendingMaintenance = pendingControls + pendingReceipts + actionableWaits + dueRoots
  let runnableInputs = 0
  let capacityBlocked = false
  try { selectAgentInput(state, catalog); runnableInputs = runnableAgentInputs(state, catalog).length } catch (error) {
    if (!(error instanceof AgentError) || error.code !== 'AGENT_LIMIT_EXCEEDED') throw error
    capacityBlocked = true
  }
  const unsupportedInputs = state.inputs.filter(input => input.status === 'queued' && input.message !== null
    && (input.protocol === undefined && !state.spec?.payload.messages.some(kind => kind.type === input.message!.type && kind.payloadVersion === input.message!.payloadVersion)
      || catalog.resolve(input.message.type, input.message.payloadVersion) === undefined)).length
  const reviewRequiredInputs = state.inputs.filter(input => input.status === 'review-required').length
  const nextWakeAt = [...state.waits.flatMap(wait => wait.settled === null && wait.created.payload.result.kind === 'wait'
    ? [wait.created.payload.result.descriptor.deadline] : []),
  ...state.roots.filter(root => root.outcome === null && root.stopControl === null).map(root => root.deadline)].sort()[0] ?? null
  let blockedBy: AgentReadinessBlock = 'none'
  if (snapshot.lifecycle === 'ended') blockedBy = 'ended'
  else if (state.openRecovery !== null) blockedBy = 'recovery-required'
  else if (state.closing !== null) blockedBy = 'closing'
  else if (state.openRun !== null) blockedBy = 'driver-active'
  else if (capacityBlocked) blockedBy = 'capacity'
  else if (runnableInputs === 0 && pendingMaintenance === 0 && reviewRequiredInputs > 0) blockedBy = 'review-required'
  else if (runnableInputs === 0 && pendingMaintenance === 0 && unsupportedInputs > 0) blockedBy = 'unsupported-input'
  else if (runnableInputs === 0 && pendingMaintenance === 0 && nextWakeAt !== null) blockedBy = 'waiting'
  else if (runnableInputs === 0 && pendingMaintenance === 0) blockedBy = 'idle'
  let available = snapshot.lifecycle === 'active' && state.openRun === null && state.openRecovery === null && state.closing === null && !capacityBlocked
  if (available) {
    try { assertAgentExecutionQuiescent(snapshot) }
    catch (cause) {
      if (!(cause instanceof AgentError)) throw cause
      blockedBy = cause.code === 'AGENT_CLEANUP_FAILED' ? 'cleanup-incomplete' : 'recovery-required'
      available = false
    }
  }
  return Object.freeze({ sourcePosition: snapshot.localPosition, canRun: available && runnableInputs > 0,
    canMaintain: available && pendingMaintenance > 0, nextWakeAt, blockedBy,
    counts: Object.freeze({ runnableInputs, pendingMaintenance, unsupportedInputs, reviewRequiredInputs }) })
}

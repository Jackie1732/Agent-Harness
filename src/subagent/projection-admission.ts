import { delegationClosure } from './closure.js'
import { originalAgentActionArguments } from '../agent/model-source.js'
import { referenceKey } from '../agent/input-codec.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { requireEntry, requireSpec } from '../agent/projection-state.js'
import { equal } from '../agent/validation.js'
import { formatSessionAddress, parseSessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { authorizeDelegation } from './authority.js'
import { reserveDelegationBudget } from './budget.js'
import type { DelegationRequested } from './event-contract.js'
import { SubagentError } from './errors.js'

/** CP-D folds into the same Agent accumulator as model/action reservations. */
export function applyDelegationRequested(state: AgentProjectionState, event: CommittedSessionEvent<DelegationRequested>): void {
  const p = event.payload
  const spec = requireSpec(state).payload
  if (spec.protocolVersion !== 2 || spec.subagents.role !== 'parent') invalid('parent-authority')
  const authority = spec.subagents
  const root = requireEntry(state.roots, p.parentRoot, 'delegation-parent-root')
  if (p.parentAddress !== formatSessionAddress(event.stored.sessionId) || parseSessionEventId(root.id).sessionId !== event.stored.sessionId
    || root.stopControl !== null || root.outcome !== null || p.observedAt >= root.deadline || state.openRecovery !== null || state.closing !== null) invalid('parent-not-admissible')
  const previous = [...state.subagents.delegations.values()].filter(item => item.payload.parentRoot === root.id)
  if (previous.length >= authority.maxDelegations) invalid('delegation-count')
  if (previous.some(item => !delegationClosure(state, item.stored.eventId, state.sources.values()).closed)) invalid('unresolved-delegation')
  const requestSource = p.source
  if (requestSource.kind === 'model') {
    const step = [...state.steps.values()].find(item => item.decided?.stored.eventId === requestSource.action.eventId)
    const decision = step?.decided
    const action = decision?.payload.actions[requestSource.action.index]
    const turn = step === undefined ? undefined : state.turns.get(step.opened.payload.turn)
    if (action?.route !== 'spawn' || decision?.payload.admitted !== true || turn?.root !== root.id
      || state.openTurn !== turn.started.stored.eventId || state.actions.has(referenceKey(requestSource.action))
      || !equal(action.source, requestSource.intent) || !equal(originalAgentActionArguments(state, action), p.request)) invalid('spawn-source')
  } else {
    const last = [...state.turns.values()].filter(turn => turn.root === root.id).at(-1)
    if (state.openRun !== null || state.openTurn !== null || last?.settled?.payload.outcome !== 'waiting') invalid('programmatic-checkpoint')
    if (previous.some(item => item.payload.source.kind === 'programmatic' && item.payload.source.requestKey === requestSource.requestKey)) invalid('duplicate-request-key')
  }
  const template = p.effectivePlan.template
  if (!authority.templates.some(item => item.templateKey === template.templateKey && item.templateVersion === template.templateVersion)) invalid('template-not-delegable')
  authorizeDelegation({ providerId: template.spec.target.provider.providerId, model: template.spec.target.model, tools: template.spec.toolNames },
    p.request.workspace, [authority.capabilities, template.capabilities])
  const reserved = reserveDelegationBudget({ parentUsed: root.budget, parentLimit: spec.budget,
    requested: p.grant, templateCap: template.spec.budget, parentGrantCap: authority.maxGrant,
    parentMaxOutputTokens: spec.target.maxOutputTokens, childMaxOutputTokens: template.spec.target.maxOutputTokens,
    maxQuestions: template.maxQuestions, maxProgress: template.maxProgress })
  if (!equal(reserved.parentProtocolReserve, p.parentProtocolReserve) || !equal(reserved.childProtocolReserve, p.childProtocolReserve)
    || !equal(reserved.mailboxReserve, p.mailboxReserve)) invalid('protocol-reservation-mismatch')
  if (p.deadline > root.deadline || Date.parse(p.deadline) > Date.parse(p.observedAt) + template.spec.rootDurationMs) invalid('delegation-deadline')
  if ([...state.subagents.delegations.values()].some(item => item.payload.childSessionId === p.childSessionId || item.payload.channelId === p.channelId)) invalid('delegation-identity-reused')
  root.budget = reserved.parentReserved
  state.subagents.delegations.set(event.stored.eventId, event)
}
function invalid(reason: string): never { throw new SubagentError('SUBAGENT_STATE_INVALID', reason) }

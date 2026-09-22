import { decodeAgentBudget } from '../agent/budget.js'
import { actionReference } from '../agent/input-codec.js'
import { agentJson, choice, equal, eventId, exact, integer, nullableId, record, text, timestamp } from '../agent/validation.js'
import { parseChannelId } from '../communication/ids.js'
import { parseModelInvocationId } from '../model/ids.js'
import { formatSessionAddress, parseSessionAddress, parseSessionId, sessionLogPosition } from '../session/ids.js'
import type { ChildBound, ChildReady, DelegationIdentity, DelegationRequested, SubagentReleaseRecorded, SubagentResourceOpened } from './event-contract.js'
import { decodeDelegationRequest, decodeDelegationWorkspace } from './request.js'
import { decodeChildTemplate } from './template.js'
import { SubagentError } from './errors.js'

function identity(value: unknown): DelegationIdentity {
  const input = record(value)
  const delegation = eventId(input.delegation)
  const parentAddress = formatSessionAddress(parseSessionAddress(text(input.parentAddress)))
  const childAddress = formatSessionAddress(parseSessionAddress(text(input.childAddress)))
  if (parentAddress === childAddress) invalid('same-session')
  return { delegation, parentAddress, childAddress }
}
const identityFields = ['delegation', 'parentAddress', 'childAddress'] as const

/** CP-D contains the exact request, immutable recipe and reservations, with no guessed child event ids. */
export function decodeDelegationRequested(value: unknown): DelegationRequested {
  const input = record(agentJson(value))
  exact(input, ['parentAddress', 'childAddress', 'childSessionId', 'channelId', 'parentRoot', 'source', 'request', 'effectivePlan',
    'grant', 'parentProtocolReserve', 'childProtocolReserve', 'mailboxReserve', 'deadline', 'observedAt'])
  parseSessionAddress(text(input.parentAddress)); parseSessionAddress(text(input.childAddress))
  const child = parseSessionId(text(input.childSessionId)); parseChannelId(text(input.channelId)); eventId(input.parentRoot)
  if (formatSessionAddress(child) !== input.childAddress || input.childAddress === input.parentAddress) invalid('child-identity')
  const source = record(input.source)
  if (source.kind === 'model') {
    exact(source, ['kind', 'intent', 'action']); actionReference(source.action)
    const intent = record(source.intent); exact(intent, ['invocationId', 'outputBlockIndex'])
    parseModelInvocationId(text(intent.invocationId)); integer(intent.outputBlockIndex)
  } else { exact(source, ['kind', 'requestKey']); choice(source.kind, ['programmatic']); text(source.requestKey, 128) }
  const plan = record(input.effectivePlan); exact(plan, ['template', 'workspace', 'childBudget', 'deadline'])
  const template = decodeChildTemplate(plan.template)
  if (!equal(template, plan.template)) invalid('noncanonical-template')
  const request = decodeDelegationRequest(input.request, template.limits)
  decodeDelegationWorkspace(plan.workspace, template.limits.maxFileEntries); decodeAgentBudget(plan.childBudget); timestamp(plan.deadline)
  if (template.templateKey !== request.templateKey || template.templateVersion !== request.templateVersion
    || !equal(plan.workspace, request.workspace) || !equal(plan.childBudget, request.requestedBudget)
    || !equal(input.grant, plan.childBudget) || input.deadline !== plan.deadline) invalid('plan-request-mismatch')
  for (const key of ['grant', 'parentProtocolReserve', 'childProtocolReserve']) decodeAgentBudget(input[key])
  const mailbox = record(input.mailboxReserve); exact(mailbox, ['parent', 'child'])
  for (const role of ['parent', 'child']) {
    const reserve = record(mailbox[role]); exact(reserve, ['inbox', 'outbox'])
    integer(reserve.inbox); integer(reserve.outbox)
  }
  if (timestamp(input.observedAt) >= timestamp(input.deadline)) invalid('expired-delegation')
  return input as DelegationRequested
}

export function decodeChildBound(value: unknown): ChildBound {
  const input = record(agentJson(value)); exact(input, [...identityFields, 'requested'])
  const id = identity(input); const requested = decodeDelegationRequested(input.requested)
  if (requested.parentAddress !== id.parentAddress || requested.childAddress !== id.childAddress) invalid('bound-identity')
  return input as ChildBound
}
export function decodeChildReady(value: unknown): ChildReady {
  const input = record(agentJson(value)); exact(input, [...identityFields, 'bound', 'profile', 'spec', 'through'])
  identity(input); eventId(input.bound); eventId(input.profile); eventId(input.spec); sessionLogPosition(integer(input.through))
  return input as ChildReady
}
export function decodeSubagentResourceOpened(value: unknown): SubagentResourceOpened {
  const input = record(agentJson(value)); exact(input, [...identityFields, 'generation', 'component', 'predecessor', 'recovery', 'workspaceGrant'])
  identity(input); integer(input.generation, 1); choice(input.component, ['execution', 'protocol'])
  nullableId(input.predecessor); nullableId(input.recovery); decodeDelegationWorkspace(input.workspaceGrant, 10000)
  return input as SubagentResourceOpened
}
export function decodeSubagentReleaseRecorded(value: unknown): SubagentReleaseRecorded {
  const input = record(agentJson(value)); exact(input, [...identityFields, 'opened', 'component', 'outcome', 'reasonCode'])
  identity(input); eventId(input.opened); choice(input.component, ['execution', 'protocol'])
  choice(input.outcome, ['released', 'cleanup-incomplete', 'unknown']); text(input.reasonCode, 128)
  return input as SubagentReleaseRecorded
}
function invalid(reason: string): never { throw new SubagentError('SUBAGENT_STATE_INVALID', reason) }

import { effectiveResourceRelease } from './resource-evidence.js'
import { projectAgentSession } from '../agent/projection.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { SessionSnapshot } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
import type { AcceptedDelegation } from './admission.js'
import type { SubagentSettlementObserved } from './lifecycle-contract.js'
import { equal } from '../agent/validation.js'
import { modelSettledEvent } from '../model/session-events.js'

/** Public lifecycle projection used by the Host; it contains no model, tool result or message content. */
export function childSettlementObservation(accepted: Pick<AcceptedDelegation, 'event'>, snapshot: SessionSnapshot): SubagentSettlementObserved | undefined {
  const state = projectAgentSession(snapshot)
  const communication = projectCommunicationFacts(snapshot)
  const root = state.roots[0]
  let business: SubagentSettlementObserved['business'] = { kind: 'pending' }
  if (root?.outcome != null) {
    const turn = state.turns.filter(item => item.root === root.id).at(-1)
    const control = state.controls.find(item => item.settled?.payload.rootOutcome === root.outcome
      && (item.requested.payload.kind === 'cancel-work' || item.requested.payload.kind === 'expire-work') && item.requested.payload.root === root.id)
    const wait = state.waits.find(item => item.created.payload.result.kind === 'wait' && item.created.payload.result.descriptor.root === root.id
      && item.settled !== null && item.settled.payload.outcome !== 'matched')
    const terminal = turn?.settled?.payload.rootOutcome != null ? turn.settled.stored.eventId : control?.settled?.stored.eventId ?? wait?.settled?.stored.eventId
    if (terminal === undefined) return undefined
    business = { kind: 'terminal', root: root.id, terminal, outcome: root.outcome }
  } else if (root === undefined) {
    const control = state.subagents.controls.find(item => item.settled?.payload.business === 'not-started')
    if (control?.settled !== null && control?.settled !== undefined) business = { kind: 'not-started', control: control.settled.stored.eventId }
  }
  // Opening a successor requires a confirmed predecessor release. Only the current generation remains an obligation.
  const latestResources = (['execution', 'protocol'] as const).flatMap(component => {
    const latest = state.subagents.resources.filter(item => item.opened.payload.component === component).at(-1)
    return latest === undefined ? [] : [latest]
  })
  const resources = latestResources.map(item => ({ opened: item.opened.stored.eventId, component: item.opened.payload.component,
    generation: item.opened.payload.generation, release: effectiveResourceRelease(item, state.subagents.recoveries)?.eventId ?? null, outcome: effectiveResourceRelease(item, state.subagents.recoveries)?.outcome ?? 'pending' as const }))
  const pendingIntents = state.subagents.protocol.filter(intent => !communication.outbox.some(item => item.sendKey?.eventId === intent.stored.eventId)
    && !state.subagents.failures.some(item => item.payload.protocol === intent.stored.eventId)).length
  const evidenceByType = new Map<string, SessionEventId>()
  for (const event of snapshot.history.at(-1)!.events.filter(event => event.stored.type === 'subagent/child-ready'
    || ['subagent/release-recorded', 'subagent/control-settled', 'subagent/delivery-failed', 'communication/outbox-delivered',
      'communication/outbox-rejected', 'communication/outbox-abandoned', 'communication/inbox-processed', 'communication/inbox-abandoned'].includes(event.stored.type))) evidenceByType.set(event.stored.type, event.stored.eventId)
  const evidence = [...evidenceByType.values()]
  if (evidence.length === 0) return undefined
  const usages = snapshot.history.at(-1)!.events.filter(event => event.stored.type === modelSettledEvent.type)
    .map(event => modelSettledEvent.decode(event.stored.payload).result.usage)
  const total = (field: 'inputTokens' | 'outputTokens'): number | null => {
    if (usages.some(usage => usage[field] === undefined)) return null
    const sum = usages.reduce((sum, usage) => sum + usage[field]!, 0)
    return Number.isSafeInteger(sum) ? sum : null
  }
  return { delegation: accepted.event.stored.eventId, parentAddress: accepted.event.payload.parentAddress, childAddress: accepted.event.payload.childAddress,
    childThrough: snapshot.localPosition, business, resources, evidence, deliveryFailures: state.subagents.failures.map(item => item.stored.eventId),
    modelUsage: { settled: usages.length, partialOrUnknown: usages.filter(usage => usage.completeness !== 'complete').length,
      inputTokens: total('inputTokens'), outputTokens: total('outputTokens') },
    protocol: { pendingIntents, pendingOutbox: communication.outbox.filter(item => item.status === 'pending').length,
      pendingInbox: communication.inbox.filter(item => item.status === 'pending').length,
      pendingControls: state.subagents.controls.filter(item => item.settled === null).length + state.controls.filter(item => item.settled === null && item.supersededBy === null).length } }
}

export function observationChanged(previous: SubagentSettlementObserved | undefined, next: SubagentSettlementObserved): boolean {
  if (previous === undefined) return true
  const { childThrough: _old, ...old } = previous
  const { childThrough: _new, ...current } = next
  return !equal(old, current)
}

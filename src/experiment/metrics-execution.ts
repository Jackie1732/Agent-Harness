import { delegationClosure } from '../subagent/closure.js'
import type { JsonObject } from '../foundation/json.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionEventRecord, StoredSessionEvent } from '../session/types.js'
import type { ExecutionMetricFacts, ExperimentCountMetricName, MetricCountFact, MetricsEventRef, MetricsSessionFacts } from './metrics-types.js'

/** Count local execution facts, preserving Provider counters and recovery ownership instead of grants. */
export function executionMetricFacts(sessions: readonly MetricsSessionFacts[]): ExecutionMetricFacts {
  const counts: MetricCountFact[] = [], usage: ExecutionMetricFacts['usage'][number][] = []
  const providers = new Map<string, ExecutionMetricFacts['providers'][number]>()
  for (const session of sessions) {
    const { snapshot, model, tools, agent, workflow, events } = session
    const ref = (event: { readonly stored: StoredSessionEvent }): MetricsEventRef => ({ address: snapshot.address, eventId: event.stored.eventId })
    const add = (name: ExperimentCountMetricName, selected: readonly { readonly stored: StoredSessionEvent }[], value = selected.length) => {
      counts.push({ name, value, refs: selected.map(ref) })
    }
    counts.push({ name: 'session.selected', value: 1, refs: [] })
    add('session.events', events)
    for (const invocation of model.invocations) {
      add('model.prepared', [invocation.prepared])
      const { binding, request } = invocation.prepared.payload.submission
      const provider = { providerId: binding.providerId, protocol: binding.protocol, adapterVersion: binding.adapterVersion, endpoint: binding.endpoint, model: request.model }
      providers.set(JSON.stringify(provider), provider)
      if ('started' in invocation && invocation.started !== undefined) add('model.started', [invocation.started])
      if (invocation.state === 'settled') {
        add('model.settled', [invocation.settled])
        if (invocation.settled.payload.external === 'response-observed') add('model.responseObserved', [invocation.settled])
        if (invocation.settled.payload.external !== 'not-issued') usage.push({ usage: invocation.settled.payload.result.usage, refs: [ref(invocation.prepared), ref(invocation.settled)] })
      } else if (invocation.state === 'started') usage.push({ usage: null, refs: [ref(invocation.prepared), ref(invocation.started)] })
    }
    for (const invocation of tools.invocations) {
      add('tool.requested', [invocation.requested])
      if ('authorization' in invocation && invocation.authorization !== undefined) {
        add(invocation.authorization.payload.decision.kind === 'allow' ? 'tool.allowed' : 'tool.denied', [invocation.authorization])
      }
      if ('started' in invocation && invocation.started !== undefined) add('tool.started', [invocation.started])
      if (invocation.state === 'settled') {
        add('tool.settled', [invocation.settled])
        if (invocation.settled.payload.execution === 'execution-observed') add('tool.executionObserved', [invocation.settled])
        if (invocation.settled.payload.cleanup.failed !== null && invocation.settled.payload.cleanup.failed > 0) add('tool.cleanupFailed', [invocation.settled])
      }
    }
    if (agent !== null) {
      const byId = new Map(events.map(event => [event.stored.eventId, event]))
      add('agent.roots', agent.roots.map(root => byId.get(root.id)!))
      add('agent.rootsCompleted', agent.roots.filter(root => root.outcome === 'completed').map(root => byId.get(root.id)!))
      add('agent.turns', agent.turns.map(turn => turn.started))
      add('agent.turnsSettled', agent.turns.flatMap(turn => turn.settled === null ? [] : [turn.settled]))
      add('agent.steps', agent.steps.map(step => step.opened))
      add('agent.stepsDecided', agent.steps.flatMap(step => step.decided === null ? [] : [step.decided]))
      add('agent.userWaits', agent.waits.filter(wait => wait.created.payload.result.kind === 'wait' && wait.created.payload.result.descriptor.kind === 'user').map(wait => wait.created))
      add('agent.userAnswers', agent.inputs.filter(input => input.input?.kind === 'answer').map(input => byId.get(input.reference.eventId)!))
      add('agent.managementControls', agent.controls.filter(control => control.requested.payload.kind !== 'recovery').map(control => control.requested))
      add('agent.waitsSettled', agent.waits.flatMap(wait => wait.settled === null ? [] : [wait.settled]))
      add('subagent.requested', agent.subagents.delegations)
      add('subagent.accepted', agent.subagents.provisions.filter(provision => provision.payload.outcome === 'installed'))
      const known = events.filter(event => event.kind === 'known')
      const closures = agent.subagents.delegations.map(delegation => ({ delegation, closure: delegationClosure(agent, delegation.stored.eventId, known) }))
      add('subagent.adopted', closures.filter(item => item.closure.adopted).map(item => item.delegation))
      add('subagent.closed', closures.filter(item => item.closure.closed).map(item => item.delegation))
    }
    if (workflow !== null) {
      if (workflow.definition !== null) add('workflow.nodes', [workflow.definition], workflow.definition.payload.nodes.length)
      add('workflow.assignments', workflow.assignments)
      add('workflow.productionAttempts', workflow.assignments.filter(assignment => assignment.payload.kind === 'production'))
      add('workflow.proposals', workflow.proposals)
      add('workflow.reviews', workflow.reviews)
      add('workflow.accepted', workflow.decisions.filter(decision => decision.payload.outcome === 'accepted'))
      add('workflow.rejected', workflow.decisions.filter(decision => decision.payload.outcome === 'rejected'))
      add('workflow.managementControls', workflow.controls.map(control => control.requested))
      for (const control of workflow.controls) {
        if (control.settled?.payload.outcome !== 'applied') continue
        if (control.requested.payload.kind === 'pause') add('workflow.paused', [control.requested, control.settled], 1)
        if (control.requested.payload.kind === 'cancel') add('workflow.cancelled', [control.requested, control.settled], 1)
      }
      add('workflow.closed', events.filter(event => event.stored.type === 'workflow/closed'))
    }
    counts.push(...recoveryFacts(session))
  }
  return { counts, usage, providers: [...providers.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, provider]) => provider) }
}

type RecoveryDomain = 'agent' | 'subagent' | 'workflow' | 'work'
type RecoveryRequest = { readonly kind?: string; readonly supersedes: SessionEventId | null }
type RecoverySettlement = { readonly control?: SessionEventId; readonly recovery?: SessionEventId }

function recoveryFacts(session: MetricsSessionFacts): MetricCountFact[] {
  const result: MetricCountFact[] = []
  const spans = new Map<SessionEventId, { readonly start: number; end: number }>()
  const domainNames: Record<RecoveryDomain, readonly [ExperimentCountMetricName, ExperimentCountMetricName, ExperimentCountMetricName]> = {
    agent: ['recovery.agentRequested', 'recovery.agentSettled', 'recovery.agentRestarted'],
    subagent: ['recovery.subagentRequested', 'recovery.subagentSettled', 'recovery.subagentRestarted'],
    workflow: ['recovery.workflowRequested', 'recovery.workflowSettled', 'recovery.workflowRestarted'],
    work: ['recovery.workRequested', 'recovery.workSettled', 'recovery.workRestarted'],
  }
  const refs = (event: SessionEventRecord): readonly MetricsEventRef[] => [{ address: session.snapshot.address, eventId: event.stored.eventId }]
  for (const event of session.events) {
    if (event.kind !== 'known') continue
    const domain = event.stored.type.split('/')[0] as RecoveryDomain
    if (!(domain in domainNames)) continue
    const requested = event.stored.type === `${domain}/recovery-requested` || event.stored.type === 'agent/control-requested'
    const settled = event.stored.type === `${domain}/recovery-settled` || event.stored.type === 'agent/control-settled'
    const names = domainNames[domain]
    if (requested) {
      // Catalog/projections own decoding; the event tag selects the existing request fields.
      const payload = event.payload as JsonObject & RecoveryRequest
      if (domain === 'agent' && payload.kind !== 'recovery') continue
      result.push({ name: names[0], value: 1, refs: refs(event) })
      if (payload.supersedes !== null) {
        result.push({ name: names[2], value: 1, refs: refs(event) })
        const previous = spans.get(payload.supersedes)
        if (previous !== undefined) previous.end = event.stored.sequence - 1
      }
      spans.set(event.stored.eventId, { start: event.stored.sequence, end: session.snapshot.localPosition })
    } else if (settled) {
      const payload = event.payload as JsonObject & RecoverySettlement
      const owner = payload.recovery ?? payload.control
      const span = owner === undefined ? undefined : spans.get(owner)
      if (span === undefined) continue
      span.end = event.stored.sequence
      result.push({ name: names[1], value: 1, refs: refs(event) })
    }
  }
  const intervals = [...spans.values()].sort((left, right) => left.start - right.start)
  const merged: { start: number; end: number }[] = []
  for (const interval of intervals) {
    const previous = merged.at(-1)
    if (previous !== undefined && interval.start <= previous.end + 1) previous.end = Math.max(previous.end, interval.end)
    else merged.push({ ...interval })
  }
  const appended = merged.flatMap(interval => session.events.slice(interval.start - 1, interval.end))
  result.push({ name: 'recovery.appendedEvents', value: appended.length, refs: appended.flatMap(refs) })
  return result
}

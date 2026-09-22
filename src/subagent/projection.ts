import { effectiveResourceRelease } from './resource-evidence.js'
import { applySubagentLifecycle } from './projection-lifecycle.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { requireEntry, requireSpec } from '../agent/projection-state.js'
import { equal } from '../agent/validation.js'
import { formatSessionAddress, parseSessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { requireDelegationBinding } from './state.js'
import { applySubagentClassification, applySubagentInputDisposed } from './projection-input.js'
import { applySubagentProtocol } from './projection-protocol.js'
import { applyDelegationRequested } from './projection-admission.js'
import * as events from './session-events.js'
import { SubagentError } from './errors.js'

/** Pure installation/resource replay shares Agent facts but never calls an Agent projector. */
export function applySubagentEvent(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const definition = events.subagentSessionEventDefinitions.find(item => item.type === event.stored.type && item.payloadVersion === event.stored.payloadVersion)
  if (definition === undefined || event.stored.ignorable === true || !equal(definition.decode(event.payload), event.payload)
    || !equal(event.payload, event.stored.payload)) invalid('noncanonical-subagent-event')
  switch (event.stored.type) {
    case 'subagent/delegation-requested':
      applyDelegationRequested(state, { ...event, payload: events.delegationRequestedEvent.decode(event.payload) }); break
    case 'subagent/child-bound': {
      const p = events.childBoundEvent.decode(event.payload)
      if (state.subagents.bound !== null || state.sources.size !== 0 || event.stored.sequence !== 1
        || p.childAddress !== formatSessionAddress(event.stored.sessionId)
        || p.parentAddress !== formatSessionAddress(parseSessionEventId(p.delegation).sessionId)
        || parseSessionEventId(p.requested.parentRoot).sessionId !== parseSessionEventId(p.delegation).sessionId) invalid('child-bound-prefix')
      state.subagents.bound = { ...event, payload: p }; break
    }
    case 'subagent/child-ready': {
      const p = events.childReadyEvent.decode(event.payload)
      const request = requireDelegationBinding(state.subagents, p)
      const bound = state.subagents.bound
      const spec = requireSpec(state)
      const profile = requireEntry(state.sources, p.profile, 'missing-child-profile')
      if (state.subagents.ready !== null || bound?.stored.eventId !== p.bound || p.spec !== spec.stored.eventId
        || p.through !== event.stored.sequence - 1 || spec.payload.protocolVersion !== 2
        || profile.stored.type !== 'context/profile-recorded' || profile.stored.payloadVersion !== 3
        || !equal(profile.payload, request.effectivePlan.template.profile)) invalid('child-installation')
      const expected = { ...request.effectivePlan.template.spec, profileEventId: p.profile, budget: request.grant,
        subagents: { role: 'child', bound: p.bound, deadline: request.deadline, protocolReserve: request.childProtocolReserve,
          maxQuestions: request.effectivePlan.template.maxQuestions, maxProgress: request.effectivePlan.template.maxProgress,
          maxFileEntries: request.effectivePlan.template.limits.maxFileEntries } }
      if (!equal(spec.payload, expected)) invalid('child-spec-binding')
      state.subagents.ready = { ...event, payload: p }; break
    }
    case 'subagent/resource-opened': {
      const p = events.subagentResourceOpenedEvent.decode(event.payload)
      const request = requireDelegationBinding(state.subagents, p)
      if (formatSessionAddress(event.stored.sessionId) === p.childAddress && state.subagents.ready === null) invalid('child-not-ready')
      const prior = [...state.subagents.resources.values()].filter(item => item.opened.payload.delegation === p.delegation && item.opened.payload.component === p.component).at(-1)
      const release = prior === undefined ? null : effectiveResourceRelease(prior, state.subagents.recoveries.values())
      if (p.generation !== (prior?.opened.payload.generation ?? 0) + 1 || p.predecessor !== (release?.eventId ?? null)
        || prior !== undefined && release?.outcome !== 'released' || p.recovery !== (release?.recovery ?? null)) invalid('resource-predecessor')
      if (!equal(p.workspaceGrant, p.component === 'protocol' ? { kind: 'none' } : request.effectivePlan.workspace)) invalid('resource-workspace')
      state.subagents.resources.set(event.stored.eventId, { opened: { ...event, payload: p }, released: null }); break
    }
    case 'subagent/workspace-baseline': {
      const p = events.workspaceBaselineRecordedEvent.decode(event.payload); const request = requireDelegationBinding(state.subagents, p)
      const execution = requireEntry(state.subagents.resources, p.execution, 'missing-baseline-execution')
      const workspace = request.effectivePlan.workspace; const tools = request.effectivePlan.template.tools
      if (state.subagents.bound === null || workspace.kind === 'none' || tools.kind !== 'workspace-text'
        || execution.opened.payload.component !== 'execution' || execution.released !== null || state.subagents.baselines.has(p.execution)
        || p.baseline.resourceId !== workspace.resourceId || !equal(p.baseline.entries.map(item => item.path), workspace.readFiles)
        || p.baseline.entries.length > tools.maxBaselineFiles || p.baseline.entries.reduce((sum, item) => sum + item.byteLength, 0) > tools.maxBaselineBytes) invalid('workspace-baseline-source')
      const original = [...state.subagents.baselines.values()][0]?.payload.baseline
      if (original !== undefined && !equal([original.rootIdentity, original.entries], [p.baseline.rootIdentity, p.baseline.entries])) invalid('workspace-baseline-changed')
      state.subagents.baselines.set(p.execution, { ...event, payload: p }); break
    }
    case 'subagent/release-recorded': {
      const p = events.subagentReleaseRecordedEvent.decode(event.payload); requireDelegationBinding(state.subagents, p)
      const resource = requireEntry(state.subagents.resources, p.opened, 'missing-resource-intent')
      if (resource.released !== null || resource.opened.payload.component !== p.component || resource.opened.payload.delegation !== p.delegation) invalid('release-owner')
      resource.released = { ...event, payload: p }; break
    }
    case 'subagent/message-classified': applySubagentClassification(state, { ...event, payload: events.subagentMessageClassifiedEvent.decode(event.payload) }); break
    case 'subagent/input-disposed': applySubagentInputDisposed(state, { ...event, payload: events.subagentInputDisposedEvent.decode(event.payload) }); break
    case 'subagent/protocol-recorded': applySubagentProtocol(state, { ...event, payload: events.subagentProtocolRecordedEvent.decode(event.payload) }); break
    default: applySubagentLifecycle(state, event)
  }
}
function invalid(reason: string): never { throw new SubagentError('SUBAGENT_STATE_INVALID', reason) }

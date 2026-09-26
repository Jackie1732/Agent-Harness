import { source } from '../agent/projection-state.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { sessionDelegationsClosed } from '../subagent/closure.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { formatSessionAddress } from '../session/ids.js'
import { invalidHistory } from './errors.js'
import { deriveWorkDelivery } from './delivery.js'
import { workAssignmentAcceptedEvent, sameWorkflowValue } from './work-binding.js'
import {  artifactPublishedEvent, workExecutionReleasedEvent, workProposalRecordedEvent , workReviewRecordedEvent } from './result-events.js'
import { projectWorkRecoveries } from './recovery-projection.js'

/** Validate output publication against preceding local business and release evidence. */
export function applyWorkResultEvent(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const sources = [...state.sources.values()]
  if (event.stored.type === workExecutionReleasedEvent.type) {
    const p = workExecutionReleasedEvent.decode(event.payload)
    const binding = source(state, p.accepted, workAssignmentAcceptedEvent)
    const root = state.roots.get(p.root)
    const previous = sources.filter(item => item.stored.type === workExecutionReleasedEvent.type && workExecutionReleasedEvent.decode(item.payload).accepted === p.accepted)
    if ('recovery' in p) {
      const recovery = projectWorkRecoveries(sources).find(item => item.requested.stored.eventId === p.recovery)
      if (recovery === undefined || recovery.supersededBy !== null || recovery.requested.payload.accepted !== p.accepted
        || previous.some(item => workExecutionReleasedEvent.decode(item.payload).outcome === 'released')) invalidHistory('work-release-recovery-source')
    } else if (previous.length > 0) invalidHistory('work-release-duplicate')
    if (state.openRun !== null || state.openTurn !== null || state.openRecovery !== null || root?.outcome == null
      || root.source.kind !== 'workflow' || !sameWorkflowValue(root.source.assignment, p.assignment)
      || !sameWorkflowValue(binding.payload.assignment, p.assignment)
      || !sessionDelegationsClosed(state, sources)) invalidHistory('work-release-source')
    return
  }
  const proposal = [workProposalRecordedEvent.type, workReviewRecordedEvent.type].includes(event.stored.type)
  const p = proposal ? workProposalRecordedEvent.decode(event.payload) : artifactPublishedEvent.decode(event.payload)
  const release = source(state, p.executionRelease, workExecutionReleasedEvent)
  if (release.payload.root !== p.root || release.payload.accepted !== p.accepted
    || !sameWorkflowValue(release.payload.assignment, p.assignment)) invalidHistory('work-result-release')
  const derived = deriveWorkDelivery(state, p.accepted, p.executionRelease)
  if (derived.proposal.root !== p.root || !sameWorkflowValue(derived.binding.assignment, p.assignment)) invalidHistory('work-result-binding')
  if (proposal && event.stored.type !== (derived.binding.value.kind === 'review' ? workReviewRecordedEvent.type : workProposalRecordedEvent.type)) invalidHistory('work-result-kind')
  const artifacts = sources.filter(item => item.stored.type === artifactPublishedEvent.type)
    .map(item => ({ ...item, payload: artifactPublishedEvent.decode(item.payload) })).filter(item => item.payload.accepted === p.accepted)
  const proposals = sources.filter(item => [workProposalRecordedEvent.type, workReviewRecordedEvent.type].includes(item.stored.type))
    .map(item => workProposalRecordedEvent.decode(item.payload)).filter(item => item.accepted === p.accepted)
  if (proposals.length !== 0) invalidHistory('work-proposal-already-published')
  if (proposal) {
    const actual = workProposalRecordedEvent.decode(event.payload)
    const refs = artifacts.map(item => ({ address: formatSessionAddress(item.stored.sessionId), eventId: item.stored.eventId }))
    if (artifacts.length !== derived.artifacts.length || actual.terminal !== derived.proposal.terminal
      || !sameWorkflowValue(actual.value, derived.proposal.value) || actual.outcome !== derived.proposal.outcome || actual.reason !== derived.proposal.reason || !sameWorkflowValue(actual.artifacts, refs)) invalidHistory('work-proposal-source')
  } else {
    const actual = artifactPublishedEvent.decode(event.payload)
    const expected = derived.artifacts[artifacts.length]
    if (expected === undefined || !sameWorkflowValue(actual, { ...expected, assignment: derived.binding.assignment,
      accepted: p.accepted, root: derived.proposal.root, executionRelease: p.executionRelease })) invalidHistory('artifact-source-mismatch')
  }
}

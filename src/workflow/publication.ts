import { AgentJournal } from '../agent/journal.js'
import { foldAgentSession } from '../agent/projection.js'
import type { Clock } from '../foundation/clock.js'
import type { SessionHandle } from '../session/session-handle.js'
import { formatSessionAddress } from '../session/ids.js'
import { deriveWorkDelivery } from './delivery.js'
import {  artifactPublishedEvent, workExecutionReleasedEvent, workProposalRecordedEvent , workReviewRecordedEvent } from './result-events.js'

/** Select one durable publication transition; rechecking sources happens in the local journal. */
export function nextWorkPublication(session: SessionHandle, clock: Clock): (() => Promise<unknown>) | undefined {
  const state = foldAgentSession(session.snapshot())
  const events = [...state.sources.values()]
  for (const released of events.filter(item => item.stored.type === workExecutionReleasedEvent.type)) {
    const release = workExecutionReleasedEvent.decode(released.payload)
    if (events.some(item => [workProposalRecordedEvent.type, workReviewRecordedEvent.type].includes(item.stored.type)
      && workProposalRecordedEvent.decode(item.payload).accepted === release.accepted)) continue
    const result = deriveWorkDelivery(state, release.accepted, released.stored.eventId)
    const artifacts = events.filter(item => item.stored.type === artifactPublishedEvent.type
      && artifactPublishedEvent.decode(item.payload).accepted === release.accepted)
    const journal = new AgentJournal(session, result.binding.recipe.limits.maxCommitConflicts, clock)
    const base = { assignment: result.binding.assignment, accepted: release.accepted, root: result.proposal.root, executionRelease: released.stored.eventId }
    const artifact = result.artifacts[artifacts.length]
    return artifact !== undefined
      ? () => journal.append(artifactPublishedEvent, () => ({ ...base, ...artifact }))
      : () => journal.append(result.binding.value.kind === 'review' ? workReviewRecordedEvent : workProposalRecordedEvent, () => ({ ...result.proposal,
        artifacts: artifacts.map(item => ({ address: formatSessionAddress(item.stored.sessionId), eventId: item.stored.eventId })) }))
  }
  return undefined
}

import { createHash } from 'node:crypto'
import { array, choice, eventId, exact, integer, record, text } from '../agent/validation.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import type { SessionEventId } from '../session/ids.js'
import { invalidHistory } from './errors.js'
import { workflowReference } from './work-binding.js'
import type { WorkflowEventRef } from './types.js'

export type WorkExecutionReleased = {
  readonly assignment: WorkflowEventRef
  readonly accepted: SessionEventId
  readonly root: SessionEventId
  readonly owner: string
  readonly generation: number
  readonly outcome: 'released' | 'unknown'
}

export type ArtifactSource = { readonly kind: 'model-final'; readonly turn: SessionEventId; readonly settled: SessionEventId }
  | { readonly kind: 'json-text'; readonly turn: SessionEventId; readonly settled: SessionEventId; readonly path: readonly string[] }
  | { readonly kind: 'write-text'; readonly requested: SessionEventId; readonly authorization: SessionEventId; readonly settled: SessionEventId }

export type WorkArtifact = {
  readonly assignment: WorkflowEventRef
  readonly accepted: SessionEventId
  readonly root: SessionEventId
  readonly executionRelease: SessionEventId
  readonly name: string
  readonly mediaType: 'text/plain'
  readonly text: string
  readonly byteLength: number
  readonly sha256: string
  readonly source: ArtifactSource
}
export type WorkProposal = {
  readonly outcome: 'completed' | 'failed' | 'cancelled' | 'result-unknown'
  readonly reason: string | null
  readonly assignment: WorkflowEventRef
  readonly accepted: SessionEventId
  readonly root: SessionEventId
  readonly terminal: SessionEventId
  readonly executionRelease: SessionEventId
  readonly value: JsonValue
  readonly artifacts: readonly WorkflowEventRef[]
}
export type WorkflowProposalMessage = {
  readonly assignment: WorkflowEventRef
  readonly proposal: WorkflowEventRef
  readonly value: WorkProposal
  readonly artifacts: readonly { readonly ref: WorkflowEventRef; readonly value: WorkArtifact }[]
}

export const workExecutionReleasedEvent = createDurableEventDefinition<WorkExecutionReleased & JsonObject>({
  type: 'work/execution-released', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'accepted', 'root', 'owner', 'generation', 'outcome'])
    return { assignment: workflowReference(p.assignment), accepted: eventId(p.accepted), root: eventId(p.root),
      owner: text(p.owner, 128), generation: integer(p.generation, 1), outcome: choice(p.outcome, ['released', 'unknown']) }
  },
})

function artifactSource(value: unknown): ArtifactSource {
  const p = record(value)
  if (p.kind === 'write-text') {
    exact(p, ['kind', 'requested', 'authorization', 'settled'])
    return { kind: p.kind, requested: eventId(p.requested), authorization: eventId(p.authorization), settled: eventId(p.settled) }
  }
  const kind = choice(p.kind, ['model-final', 'json-text'])
  exact(p, kind === 'model-final' ? ['kind', 'turn', 'settled'] : ['kind', 'turn', 'settled', 'path'])
  const source = { turn: eventId(p.turn), settled: eventId(p.settled) }
  return kind === 'model-final' ? { kind, ...source } : { kind, ...source, path: array(p.path, 32).map(part => text(part, 128)) }
}

export const artifactPublishedEvent = createDurableEventDefinition<WorkArtifact & JsonObject>({
  type: 'artifact/published', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value)
    exact(p, ['assignment', 'accepted', 'root', 'executionRelease', 'name', 'mediaType', 'text', 'byteLength', 'sha256', 'source'])
    const content = text(p.text, 4 * 1024 * 1024, true)
    const byteLength = Buffer.byteLength(content)
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    if (p.byteLength !== byteLength || p.sha256 !== sha256) invalidHistory('artifact-content-digest')
    return { assignment: workflowReference(p.assignment), accepted: eventId(p.accepted), root: eventId(p.root),
      executionRelease: eventId(p.executionRelease), name: text(p.name, 128), mediaType: choice(p.mediaType, ['text/plain']),
      text: content, byteLength, sha256, source: artifactSource(p.source) }
  },
})

export const workProposalRecordedEvent = createDurableEventDefinition<WorkProposal & JsonObject>({
  type: 'work/proposal-recorded', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'accepted', 'root', 'terminal', 'executionRelease', 'value', 'artifacts', 'outcome', 'reason'])
    return { assignment: workflowReference(p.assignment), accepted: eventId(p.accepted), root: eventId(p.root),
      outcome: choice(p.outcome, ['completed', 'failed', 'cancelled', 'result-unknown']), reason: p.reason === null ? null : text(p.reason, 1024),
      terminal: eventId(p.terminal), executionRelease: eventId(p.executionRelease), value: snapshotJson(p.value),
      artifacts: array(p.artifacts, 1024).map(workflowReference) }
  },
})

/** A receiver validates the copy itself; references never open the producer's Session. */
export function decodeWorkflowProposalMessage(value: unknown): WorkflowProposalMessage & JsonObject {
  const p = record(value); exact(p, ['assignment', 'proposal', 'value', 'artifacts'])
  return { assignment: workflowReference(p.assignment), proposal: workflowReference(p.proposal),
    value: workProposalRecordedEvent.decode(p.value!), artifacts: array(p.artifacts, 1024).map(item => {
      const copy = record(item); exact(copy, ['ref', 'value'])
      return { ref: workflowReference(copy.ref), value: artifactPublishedEvent.decode(copy.value!) }
    }) }
}

export const workReviewRecordedEvent = createDurableEventDefinition({ type: 'work/review-recorded', payloadVersion: 1, ignorable: false,
  decode: workProposalRecordedEvent.decode })

export const workResultEventDefinitions = [workExecutionReleasedEvent, artifactPublishedEvent, workProposalRecordedEvent, workReviewRecordedEvent] as const

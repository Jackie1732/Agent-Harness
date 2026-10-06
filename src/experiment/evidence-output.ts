import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { projectAgentSession } from '../agent/projection.js'
import type { AgentRootState } from '../agent/state.js'
import { projectModelSession } from '../model/projection.js'
import { projectToolSession } from '../tool/projection.js'
import { requestedArguments } from '../tool/source.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { artifactPublishedEvent } from '../workflow/result-events.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import type { JsonObject } from '../foundation/json.js'
import type { ExperimentEvidenceTarget, ExperimentObservedOutput } from './evidence-types.js'
import { experimentBytesDigest } from './parsing.js'
import { readExperimentFile } from './storage.js'

/** Locate the root claimed from one exact local user receipt or accepted Workflow assignment. */
export function experimentAgentRoot(snapshot: SessionSnapshot, inputEventId: SessionEventId): AgentRootState | undefined {
  const agent = projectAgentSession(snapshot)
  const input = agent.inputs.find(item => item.reference.eventId === inputEventId
    && (item.reference.kind === 'user' || item.reference.kind === 'workflow' && item.work !== undefined))
  const turn = agent.turns.find(item => item.started.stored.eventId === input?.claimedBy)
  return agent.roots.find(item => item.id === turn?.root)
}

/** Read authenticated output facts; workspace changes are separate observations. */
export async function selectExperimentOutput(snapshots: readonly SessionSnapshot[], target: ExperimentEvidenceTarget,
  workspaceRoot: string | null, maxBytes: number): Promise<ExperimentObservedOutput> {
  const snapshot = snapshots.find(item => item.header.sessionId === target.sessionId)
  const unavailable = (reason: string): ExperimentObservedOutput => ({ status: 'unavailable', reason, sources: [] })
  if (snapshot === undefined) return unavailable('target-session-missing')
  let text: string
  let sources: ExperimentObservedOutput['sources']
  let workspaceObservation: Extract<ExperimentObservedOutput, { status: 'available' }>['workspaceObservation'] = null
  if (target.kind === 'workflow') {
    const workflow = projectWorkflowSession(snapshot)
    const decision = workflow.decisions.filter(item => item.payload.outcome === 'accepted' && workflow.assignments.some(assignment =>
      assignment.payload.kind === 'production' && assignment.payload.nodeKey === target.selector.nodeKey
      && assignment.stored.eventId === item.payload.assignment.eventId && item.payload.assignment.address === snapshot.address))
    if (decision.length !== 1) return unavailable('accepted-output-not-unique')
    const refs = decision[0]!.payload.artifacts
    const artifacts = snapshots.flatMap(session => session.history.at(-1)!.events.flatMap(event => {
        if (event.kind !== 'known' || event.stored.type !== artifactPublishedEvent.type) return []
        const artifact = artifactPublishedEvent.decode(event.payload)
        return artifact.name === target.selector.artifactName && refs.some(ref => ref.address === session.address && ref.eventId === event.stored.eventId)
          ? [{ artifact, ref: { address: session.address, eventId: event.stored.eventId } }] : []
      }))
    if (artifacts.length !== 1) return unavailable('artifact-not-unique')
    text = artifacts[0]!.artifact.text
    sources = [{ address: snapshot.address, eventId: decision[0]!.stored.eventId }, artifacts[0]!.ref]
  } else {
    const root = experimentAgentRoot(snapshot, target.inputEventId)
    if (root === undefined || root.outcome !== 'completed') return unavailable('root-not-completed')
    const agent = projectAgentSession(snapshot)
    if (target.selector.kind === 'root-final') {
      const turns = agent.turns.filter(turn => turn.root === root.id && turn.settled?.payload.outcome === 'completed')
      const turn = turns.at(-1)
      const step = agent.steps.find(item => item.opened.stored.eventId === turn?.settled?.payload.finalStep)
      const modelRef = step?.decided?.payload.model
      const model = projectModelSession(snapshot).invocations.find(item => item.state === 'settled'
        && item.settled.stored.eventId === modelRef?.settled)
      if (model?.state !== 'settled' || model.settled.payload.outcome !== 'completed') return unavailable('final-model-missing')
      const blocks = model.settled.payload.result.blocks
      if (blocks.some(block => block.kind !== 'text' || !block.complete)) return unavailable('final-not-complete-text')
      text = blocks.map(block => block.kind === 'text' ? block.text : '').join('')
      sources = [{ address: snapshot.address, eventId: turn!.settled!.stored.eventId },
        { address: snapshot.address, eventId: model.settled.stored.eventId }]
    } else {
      const outputPath = target.selector.path
      const actionSettlements = new Set(agent.actions.filter(action => {
        const step = agent.steps.find(item => item.decided?.stored.eventId === action.payload.action.eventId)
        return agent.turns.some(turn => turn.root === root.id && turn.started.stored.eventId === step?.opened.payload.turn)
          && action.payload.result.kind === 'tool'
      }).map(action => action.payload.result.kind === 'tool' ? action.payload.result.settled : ''))
      const candidates = projectToolSession(snapshot).invocations.filter(item => item.state === 'settled'
        && actionSettlements.has(item.settled.stored.eventId) && item.requested.payload.name === 'write_text'
        && item.settled.payload.outcome === 'succeeded' && item.settled.payload.result.kind === 'success')
        .flatMap(item => {
          if (item.state !== 'settled') return []
          const value = requestedArguments(item.requested.payload)
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
          const input = value as JsonObject
          if (input.path !== outputPath || typeof input.text !== 'string') return []
          return [{ item, input }]
        })
      if (candidates.length !== 1) return unavailable('write-output-not-unique')
      const { item, input } = candidates[0]!
      text = input.text as string
      if (item.state !== 'settled' || item.settled.payload.result.kind !== 'success') return unavailable('write-result-missing')
      const value = item.settled.payload.result.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return unavailable('source-mismatch')
      const result = value as JsonObject
      const bytes = Buffer.from(text, 'utf8')
      if (result.byteLength !== bytes.byteLength || result.sha256 !== experimentBytesDigest(bytes)) return unavailable('source-mismatch')
      sources = [{ address: snapshot.address, eventId: item.requested.stored.eventId }, { address: snapshot.address, eventId: item.settled.stored.eventId }]
      if (workspaceRoot !== null) {
        const path = join(workspaceRoot, target.selector.path)
        try {
          const size = (await stat(path)).size
          if (size <= maxBytes) {
            const bytes = await readExperimentFile(path, maxBytes)
            workspaceObservation = { path: target.selector.path, byteLength: bytes.byteLength, sha256: experimentBytesDigest(bytes) }
          }
        } catch (cause) {
          if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause
        }
      }
    }
  }
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength > maxBytes) return unavailable('output-limit-exceeded')
  return { status: 'available', mediaType: target.mediaType, sourceMediaType: 'text/plain', text, byteLength: bytes.byteLength,
    sha256: experimentBytesDigest(bytes), sources, workspaceObservation }
}

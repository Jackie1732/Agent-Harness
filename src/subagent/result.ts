import { effectiveResourceRelease } from './resource-evidence.js'
import { createHash } from 'node:crypto'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { requireEntry } from '../agent/projection-state.js'
import { equal, record, text } from '../agent/validation.js'
import { inputKey } from '../agent/input-codec.js'
import { modelSettledEvent } from '../model/session-events.js'
import { toolAuthorizationEvent, toolRequestedEvent, toolSettledEvent } from '../tool/session-events.js'
import type { SubagentFile, SubagentMessagePayloads, SubagentUncertainFile } from './messages.js'
import { decodeSubagentMessage } from './messages.js'
import type { DelegationIdentity } from './event-contract.js'
import { requireDelegationBinding } from './state.js'
import { SubagentError } from './errors.js'

/** Derive result content only from the child's own terminal model/tool and actual release facts. */
export function childResultPayload(state: AgentProjectionState, id: DelegationIdentity): SubagentMessagePayloads['result'] {
  const request = requireDelegationBinding(state.subagents, id)
  const root = [...state.roots.values()][0]
  if (state.subagents.bound === null || root?.outcome == null) invalid('child-business-open')
  const turns = [...state.turns.values()].filter(turn => turn.root === root.id)
  const terminal = turns.at(-1)
  if (terminal?.settled === null || terminal?.settled === undefined) invalid('child-turn-open')
  const terminalControl = [...state.controls.values()].find(item => item.settled?.payload.rootOutcome === root.outcome
    && (item.requested.payload.kind === 'cancel-work' || item.requested.payload.kind === 'expire-work') && item.requested.payload.root === root.id)
  const terminalWait = [...state.waits.values()].find(item => item.settled !== null && item.settled.payload.outcome !== 'matched'
    && item.created.payload.result.kind === 'wait' && item.created.payload.result.descriptor.root === root.id)
  const terminalSource = terminal.settled.payload.rootOutcome !== null ? terminal.settled.stored.eventId
    : terminalControl?.settled?.stored.eventId ?? terminalWait?.settled?.stored.eventId
  if (terminalSource === undefined) invalid('child-terminal-source')
  const rootInput = state.inputs.get(inputKey(turns[0]!.started.payload.input))
  if (rootInput?.protocol?.kind !== 'task') invalid('child-task-source')
  const resource = [...state.subagents.resources.values()].filter(item => item.opened.payload.component === 'execution').at(-1)
  const release = resource === undefined ? null : effectiveResourceRelease(resource, state.subagents.recoveries.values())
  if (release === null || release.outcome === 'unknown') invalid('child-release-unconfirmed')
  const step = [...state.steps.values()].find(item => item.opened.stored.eventId === terminal.settled!.payload.finalStep)
  let summaryText = root.reason ?? root.outcome
  const modelId = step?.decided?.payload.model?.settled
  if (modelId !== undefined) {
    const event = requireEntry(state.sources, modelId, 'missing-final-model')
    summaryText = modelSettledEvent.decode(event.payload).result.blocks.flatMap(block => block.kind === 'text' && block.complete ? [block.text] : []).join('')
  }
  const sources = [...state.sources.values()]
  const modelInvocations = new Set<string>([...state.steps.values()].filter(item => turns.some(turn => turn.started.stored.eventId === item.opened.payload.turn))
    .flatMap(item => item.decided?.payload.model == null ? [] : [item.decided.payload.model.invocationId]))
  const files: SubagentFile[] = []
  const uncertainFiles: SubagentUncertainFile[] = []
  for (const event of sources.filter(item => item.stored.type === toolRequestedEvent.type)) {
    const cp0 = toolRequestedEvent.decode(event.payload)
    if (cp0.name !== 'write_text' || cp0.source.kind !== 'model' || !modelInvocations.has(cp0.source.intent.invocationId)) continue
    const authorization = sources.find(item => item.stored.type === toolAuthorizationEvent.type && record(item.payload).requestedEventId === event.stored.eventId)
    const settled = sources.find(item => item.stored.type === toolSettledEvent.type && record(item.payload).invocationId === cp0.invocationId)
    if (authorization === undefined) continue
    const plan = toolAuthorizationEvent.decode(authorization.payload).plan
    if (plan.target.kind !== 'workspace-file') invalid('write-target')
    const base = { resourceId: plan.target.rootId, path: plan.target.path, source: event.stored.eventId }
    if (settled === undefined) invalid('write-unsettled')
    const cp2 = toolSettledEvent.decode(settled.payload)
    if (cp2.result.kind === 'success' && cp2.cleanup.status === 'complete' && cp2.execution === 'execution-observed') {
      const bytes = Buffer.from(text(record(plan.input).text, plan.target.maxBytes, true), 'utf8')
      const metadata = { path: base.path, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      if (!equal(cp2.result.value, metadata)) invalid('write-result-metadata')
      files.push({ ...base, byteLength: metadata.byteLength, sha256: metadata.sha256 })
    } else if (cp2.emission !== 'none') uncertainFiles.push({ ...base, reasonCode: cp2.failure?.code ?? 'write-result-unknown' })
  }
  const limits = request.effectivePlan.template.limits
  if (files.length + uncertainFiles.length > limits.maxFileEntries) invalid('result-file-capacity')
  const result: SubagentMessagePayloads['result'] = { delegation: id.delegation, parentRoot: request.parentRoot, childSessionId: request.childSessionId,
    childRoot: root.id, outcome: root.outcome, summary: { text: summaryText, sourceBytes: Buffer.byteLength(summaryText), truncated: false },
    files, uncertainFiles, executionRelease: { eventId: release.eventId, outcome: release.outcome },
    source: { turn: terminal.started.stored.eventId, settled: terminal.settled.stored.eventId, terminal: terminalSource } }
  return truncateResult(result, limits.maxResultBytes)
}

/** Keep all file evidence; only the deterministic text summary can be shortened. */
function truncateResult(result: SubagentMessagePayloads['result'], maximum: number): SubagentMessagePayloads['result'] {
  if (Buffer.byteLength(JSON.stringify(result)) <= maximum) return decodeSubagentMessage('result', result)
  const points = Array.from(result.summary.text)
  let low = 0; let high = points.length; let selected = ''
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const candidate = points.slice(0, length).join('')
    const bytes = Buffer.byteLength(JSON.stringify({ ...result, summary: { ...result.summary, text: candidate, truncated: true } }))
    if (bytes <= maximum) { selected = candidate; low = length + 1 } else high = length - 1
  }
  const truncated = { ...result, summary: { ...result.summary, text: selected, truncated: true } }
  if (Buffer.byteLength(JSON.stringify(truncated)) > maximum) invalid('result-metadata-capacity')
  return decodeSubagentMessage('result', truncated)
}
function invalid(reason: string): never { throw new SubagentError('SUBAGENT_STATE_INVALID', reason) }

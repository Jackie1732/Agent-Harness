import type { SessionSnapshot } from '../session/types.js'
import type { ToolRequestedPayload } from '../tool/contract.js'
import { record } from '../agent/validation.js'
import { decodeSubagentAgentSpec } from '../agent/spec-codec.js'
import { ToolError } from '../tool/errors.js'
import { parseBoundedJson } from '../schema/bounded-json.js'
import { workspaceRelativePath } from '../tool/workspace-path.js'
import { childBoundEvent } from './session-events.js'
import { resultMetadataBytes } from './record-budget.js'

/** Count accepted create-file intents before Tool CP0; failure and unknown execution never refund a result slot. */
export function assertDelegatedWriteCapacity(snapshot: SessionSnapshot, payload: ToolRequestedPayload, beforeSequence = snapshot.localPosition + 1): void {
  if (payload.name !== 'write_text') return
  const events = snapshot.history.at(-1)!.events.filter(item => item.stored.sequence < beforeSequence)
  const installed = events.find(item => item.stored.type === 'agent/spec-recorded' && item.stored.payloadVersion === 2)
  if (installed?.kind !== 'known') return
  const spec = decodeSubagentAgentSpec(installed.payload)
  if (spec.subagents.role !== 'child') return
  const prior = events.filter(item => item.stored.type === 'tool/invocation-requested' && record(item.stored.payload).name === 'write_text')
  if (prior.length >= spec.subagents.maxFileEntries) throw new ToolError('TOOL_RECORD_BUDGET', 'delegation-file-entry-limit')
  const path = writePath(payload)
  if (path === undefined) return
  const paths = prior.flatMap(item => { const path = writePath(item.stored.payload as ToolRequestedPayload); return path === undefined ? [] : [path] })
  if (paths.some(previous => previous.toLowerCase() === path.toLowerCase())) throw new ToolError('TOOL_RECORD_BUDGET', 'delegation-file-path-already-attempted')
  const boundId = spec.subagents.bound
  const bound = events.find(item => item.stored.eventId === boundId)!
  const request = childBoundEvent.decode(bound.stored.payload).requested
  if (request.effectivePlan.workspace.kind === 'none' || resultMetadataBytes([...paths, path], request.effectivePlan.workspace.resourceId) > request.effectivePlan.template.limits.maxResultBytes) {
    throw new ToolError('TOOL_RECORD_BUDGET', 'delegation-file-metadata-limit')
  }
}
function writePath(payload: ToolRequestedPayload): string | undefined {
  try {
    const input = payload.arguments.kind === 'json' ? payload.arguments.value : parseBoundedJson(payload.arguments.text,
      { maxBytes: payload.limits.maxArgumentsBytes, maxDepth: payload.limits.maxJsonDepth, maxNodes: payload.limits.maxJsonNodes })
    return workspaceRelativePath(record(input).path, 4096)
  } catch { return undefined }
}

import { createHash } from 'node:crypto'
import { compileInlineValidator } from '../schema/inline-validator.js'
import { source } from '../agent/projection-state.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { boundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import { modelSettledEvent } from '../model/session-events.js'
import { toolAuthorizationEvent, toolRequestedEvent, toolSettledEvent } from '../tool/session-events.js'
import type { SessionEventId } from '../session/ids.js'
import { WorkflowError } from './errors.js'
import type { WorkflowDefinition } from './types.js'
import type { ArtifactSource, WorkArtifact } from './result-events.js'
import { workAssignmentAcceptedEvent, sameWorkflowValue } from './work-binding.js'

function invalid(reason: string): never { throw new WorkflowError('WORKFLOW_RESULT_INVALID', reason) }

export function workflowValue(value: unknown, recipe: WorkflowDefinition): JsonValue {
  try { return boundedJson(value, { maxBytes: recipe.limits.maxValueBytes,
    maxDepth: recipe.limits.maxSchemaDepth, maxNodes: recipe.limits.maxSchemaNodes }) }
  catch (cause) { if (cause instanceof JsonBoundaryError) invalid('output-value-limit'); throw cause }
}

export function workflowField(value: JsonValue, path: readonly string[]): JsonValue | undefined {
  let selected = value
  for (const part of path) {
    if (selected === null || typeof selected !== 'object' || Array.isArray(selected) || !Object.hasOwn(selected, part)) return undefined
    selected = (selected as JsonObject)[part]!
  }
  return selected
}

/** Validate whole JSON output without extracting fences, coercing types or inventing missing values. */
export function validateWorkValue(value: unknown, recipe: WorkflowDefinition, nodeKey: string): JsonValue {
  const checked = workflowValue(value, recipe)
  const output = recipe.nodes.find(node => node.nodeKey === nodeKey)!.output
  if (output.kind === 'text' ? typeof checked !== 'string' : !compileInlineValidator(output.schema)(checked)) invalid('output-schema')
  return checked
}

/** Read only the selected root's committed terminal Model and successful Tool evidence. */
export function deriveWorkOutput(state: AgentProjectionState, accepted: SessionEventId) {
  const binding = source(state, accepted, workAssignmentAcceptedEvent).payload
  const root = [...state.roots.values()].find(item => item.source.kind === 'workflow' && sameWorkflowValue(item.source.assignment, binding.assignment))
  if (root?.outcome !== 'completed') invalid('work-root-not-completed')
  const turns = [...state.turns.values()].filter(turn => turn.root === root.id)
  const final = turns.at(-1)!
  if (final.settled?.payload.rootOutcome !== 'completed') invalid('work-terminal-source')
  const step = [...state.steps.values()].find(item => item.opened.stored.eventId === final.settled!.payload.finalStep)
  const model = step?.decided?.payload.model
  if (model === null || model === undefined) invalid('work-final-model')
  const settled = source(state, model.settled, modelSettledEvent)
  if (settled.payload.outcome !== 'completed') invalid('work-final-model-incomplete')
  const content = settled.payload.result.blocks.flatMap(block => block.kind === 'text' && block.complete ? [block.text] : []).join('')
  const node = binding.recipe.nodes.find(node => node.nodeKey === binding.value.nodeKey)!
  let value: JsonValue = content
  if (node.output.kind === 'json') {
    try { value = JSON.parse(content) as JsonValue } catch { invalid('output-json') }
  }
  value = validateWorkValue(value, binding.recipe, node.nodeKey)
  const modelSource = { turn: final.started.stored.eventId, settled: settled.stored.eventId }
  const artifacts: Omit<WorkArtifact, 'assignment' | 'accepted' | 'root' | 'executionRelease'>[] = []
  const add = (name: string, text: string, source: ArtifactSource) => {
    if (Buffer.from(text, 'utf8').toString('utf8') !== text) invalid('artifact-utf8')
    const byteLength = Buffer.byteLength(text)
    if (byteLength > binding.recipe.limits.maxArtifactBytes) invalid('artifact-byte-limit')
    artifacts.push({ name, mediaType: 'text/plain', text, byteLength, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), source })
  }
  if (node.output.kind === 'text') add(node.output.name, content, { kind: 'model-final', ...modelSource })
  else for (const declared of node.output.artifacts) {
    if (declared.source.kind === 'json-text') {
      const text = workflowField(value, declared.source.path)
      if (typeof text !== 'string') invalid('artifact-json-text')
      add(declared.name, text, { kind: 'json-text', ...modelSource, path: declared.source.path })
    } else {
      const invocations = new Set<string>([...state.steps.values()].filter(item => turns.some(turn => turn.started.stored.eventId === item.opened.payload.turn))
        .flatMap(item => item.decided?.payload.model == null ? [] : [item.decided.payload.model.invocationId]))
      const files = [...state.sources.values()].filter(item => item.stored.type === toolRequestedEvent.type).flatMap(event => {
        const request = toolRequestedEvent.decode(event.payload)
        if (request.name !== 'write_text' || request.source.kind !== 'model' || !invocations.has(request.source.intent.invocationId)) return []
        const authorization = [...state.sources.values()].find(item => item.stored.type === toolAuthorizationEvent.type
          && toolAuthorizationEvent.decode(item.payload).requestedEventId === event.stored.eventId)
        if (authorization === undefined) return []
        const plan = toolAuthorizationEvent.decode(authorization.payload).plan
        if (plan.target.kind !== 'workspace-file' || plan.target.path !== declared.source.path) return []
        const terminal = [...state.sources.values()].find(item => item.stored.type === toolSettledEvent.type
          && toolSettledEvent.decode(item.payload).invocationId === request.invocationId)
        if (terminal === undefined) invalid('artifact-write-unsettled')
        const result = toolSettledEvent.decode(terminal.payload)
        if (result.result.kind !== 'success' || result.cleanup.status !== 'complete' || result.execution !== 'execution-observed') invalid('artifact-write-not-confirmed')
        const workspace = binding.value.workspace
        if (workspace.kind !== 'exclusive-write' || plan.target.rootId !== workspace.resourceId
          || !workspace.writePrefixes.some(prefix => plan.target.kind === 'workspace-file' && plan.target.path.startsWith(prefix + '/'))) invalid('artifact-write-authority')
        const text = (plan.input as { readonly text?: JsonValue }).text
        if (typeof text !== 'string' || !sameWorkflowValue(result.result.value, { path: plan.target.path,
          byteLength: Buffer.byteLength(text), sha256: createHash('sha256').update(text, 'utf8').digest('hex') })) invalid('artifact-write-metadata')
        return [{ text, source: { kind: 'write-text' as const, requested: event.stored.eventId,
          authorization: authorization.stored.eventId, settled: terminal.stored.eventId } }]
      })
      if (files.length !== 1) invalid('artifact-write-source-count')
      add(declared.name, files[0]!.text, files[0]!.source)
    }
  }
  if (artifacts.length > binding.recipe.limits.maxArtifactsPerAttempt
    || artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0) > binding.recipe.limits.maxTotalArtifactBytes) invalid('artifact-capacity')
  return { binding, root: root.id, terminal: final.settled.stored.eventId, value, artifacts }
}

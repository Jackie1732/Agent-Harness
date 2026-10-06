import { snapshotJson } from '../foundation/json.js'
import { boundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import { formatSessionEventId, parseSessionEventId, parseSessionId, sessionLogPosition } from '../session/ids.js'
import type { ExperimentLimits } from './definition-types.js'
import type { ExperimentEvidence, ExperimentEvidenceTarget, ExperimentObservedOutput } from './evidence-types.js'
import { decodeEvidenceEventRef, decodeEvidenceFileDigest, decodeEvidenceSessionCut, decodeMetricsCoverage, evidenceFinite } from './evidence-codec-fields.js'
import { decodeExperimentMetrics } from './metrics-codec.js'
import type { ExperimentMeasurement } from './runner-types.js'
import { ExperimentError } from './errors.js'
import { experimentArray as array, experimentChoice as choice, experimentDigest as digest, experimentInteger as integer, experimentKeys as exact,
  experimentObject as object, experimentRelativePath as path, experimentText as text, experimentUnique as unique, experimentBytesDigest, invalidExperiment as invalid } from './parsing.js'

/** Decode bounded persisted evidence; raw and framed-prefix digests retain separate identities. */
export function decodeExperimentEvidence(value: unknown, limits: Pick<ExperimentLimits, 'maxEvidenceBytes' | 'maxSessionCount' | 'maxEvents' | 'maxMetricSamples'>): ExperimentEvidence {
  try { return decodeEvidence(boundedJson(value, { maxBytes: limits.maxEvidenceBytes, maxDepth: 64, maxNodes: limits.maxEvidenceBytes }), limits) }
  catch (cause) {
    if (cause instanceof ExperimentError) throw cause
    throw new ExperimentError(cause instanceof JsonBoundaryError && cause.reason !== 'invalid' ? 'EXPERIMENT_LIMIT_EXCEEDED' : 'EXPERIMENT_INPUT_INVALID', 'evidence-json-invalid')
  }
}

function decodeEvidence(value: unknown, limits: Pick<ExperimentLimits, 'maxEvidenceBytes' | 'maxSessionCount' | 'maxEvents' | 'maxMetricSamples'>): ExperimentEvidence {
  const input = object(value, 'evidence')
  exact(input, ['version', 'digestDomains', 'source', 'scope', 'mode', 'selectedSessionIds', 'selections', 'sessions', 'coverage', 'target', 'output', 'metrics'], 'evidence')
  if (input.version !== 1) invalid('evidence-version')
  const domains = object(input.digestDomains, 'digest-domains'); exact(domains, ['files', 'logs', 'metadata'], 'digest-domains')
  if (domains.files !== 'raw-sha256/v1' || domains.logs !== 'framed-prefix-sha256/v1' || domains.metadata !== 'sorted-json-sha256/v1') invalid('evidence-digest-domains')
  const source = object(input.source, 'evidence-source'); exact(source, ['root', 'maxRecordBytes', 'maxLineageDepth'], 'evidence-source')
  text(source.root, 'evidence-root'); integer(source.maxRecordBytes, 'evidence-record-budget'); integer(source.maxLineageDepth, 'evidence-lineage-depth', 0)
  const scope = choice(input.scope, ['unit-local/v1', 'historical-local/v1'], 'evidence-scope'), mode = choice(input.mode, ['fixture', 'live', 'historical'], 'evidence-mode')
  const ids = array(input.selectedSessionIds, 'evidence-selected', limits.maxSessionCount).map(value => parseSessionId(text(value, 'selected-session', 36)))
  unique(ids, 'selected-session')
  const selections = array(input.selections, 'evidence-selections', limits.maxSessionCount).map(value => {
    const item = object(value, 'evidence-selection'); exact(item, ['sessionId', 'through'], 'evidence-selection')
    return { sessionId: parseSessionId(text(item.sessionId, 'selection-session', 36)), through: item.through === null ? null : sessionLogPosition(integer(item.through, 'selection-through', 0)) }
  })
  if (selections.length !== ids.length || new Set(selections.map(item => item.sessionId)).size !== ids.length || selections.some(item => !ids.includes(item.sessionId))) invalid('evidence-selection-matrix')
  const sessions = array(input.sessions, 'evidence-sessions', limits.maxSessionCount).map(decodeEvidenceSessionCut)
  unique(sessions.map(item => item.sessionId), 'evidence-session')
  if (sessions.reduce((sum, item) => sum + item.header.byteLength + item.log.byteLength, 0) > limits.maxEvidenceBytes
    || sessions.reduce((sum, item) => sum + item.through, 0) > limits.maxEvents) invalid('evidence-source-budget')
  for (const session of sessions) if ((session.role === 'selected') !== ids.includes(session.sessionId)) invalid('evidence-cut-role')
  for (const selection of selections) if (selection.through !== null && !sessions.some(session => session.sessionId === selection.sessionId && selection.through! <= session.through)) invalid('evidence-selection-cut')
  const coverage = decodeMetricsCoverage(input.coverage, limits.maxSessionCount)
  if (coverage.observedSessions !== selections.filter(item => item.through !== null).length || coverage.complete && selections.some(item => item.through === null)) invalid('evidence-selection-coverage')
  if (input.target !== null) decodeTarget(input.target)
  const output = decodeOutput(input.output, limits.maxEvidenceBytes)
  if (output.status === 'available' && (input.target === null || output.sources.length === 0)) invalid('output-source-missing')
  const metrics = decodeExperimentMetrics(input.metrics, limits)
  if (metrics.mode !== mode || metrics.scope !== scope) invalid('evidence-metrics-mode-or-scope')
  return input as unknown as ExperimentEvidence
}

function decodeTarget(value: unknown): ExperimentEvidenceTarget {
  const input = object(value, 'evidence-target')
  const kind = choice(input.kind, ['agent', 'workflow'], 'evidence-target-kind')
  exact(input, kind === 'agent' ? ['kind', 'sessionId', 'mediaType', 'inputEventId', 'selector'] : ['kind', 'sessionId', 'mediaType', 'selector'], 'evidence-target')
  const sessionId = parseSessionId(text(input.sessionId, 'target-session', 36)), mediaType = choice(input.mediaType, ['text/plain', 'application/json'], 'target-media')
  const selector = object(input.selector, 'target-selector')
  if (kind === 'workflow') {
    exact(selector, ['kind', 'nodeKey', 'artifactName'], 'workflow-selector')
    if (selector.kind !== 'workflow-artifact') invalid('workflow-selector-kind')
    return { kind, sessionId, mediaType, selector: { kind: 'workflow-artifact', nodeKey: text(selector.nodeKey, 'nodeKey', 128), artifactName: text(selector.artifactName, 'artifactName', 128) } }
  }
  const event = parseSessionEventId(text(input.inputEventId, 'target-input', 80))
  if (event.sessionId !== sessionId) invalid('target-input-session')
  const inputEventId = formatSessionEventId(sessionId, event.sequence)
  if (selector.kind === 'root-final') { exact(selector, ['kind'], 'root-selector'); return { kind, sessionId, mediaType, inputEventId, selector: { kind: 'root-final' } } }
  exact(selector, ['kind', 'path'], 'write-selector')
  if (selector.kind !== 'write-text') invalid('write-selector-kind')
  return { kind, sessionId, mediaType, inputEventId, selector: { kind: 'write-text', path: path(selector.path, 'write-path') } }
}
function decodeOutput(value: unknown, maxBytes: number): ExperimentObservedOutput {
  const input = object(value, 'evidence-output'), status = choice(input.status, ['available', 'unavailable'], 'output-status')
  const sources = array(input.sources, 'output-sources', maxBytes).map(decodeEvidenceEventRef)
  if (status === 'unavailable') {
    exact(input, ['status', 'reason', 'sources'], 'output-unavailable')
    return { status, reason: text(input.reason, 'output-reason', 4096), sources }
  }
  exact(input, ['status', 'mediaType', 'sourceMediaType', 'text', 'byteLength', 'sha256', 'sources', 'workspaceObservation'], 'output-available')
  choice(input.mediaType, ['text/plain', 'application/json'], 'output-media')
  const content = text(input.text, 'output-text', maxBytes, true)
  if (input.sourceMediaType !== 'text/plain' || integer(input.byteLength, 'output-bytes', 0) !== Buffer.byteLength(content)
    || digest(input.sha256, 'output-sha256') !== experimentBytesDigest(Buffer.from(content))) invalid('output-byte-identity')
  if (input.workspaceObservation !== null) decodeEvidenceFileDigest(input.workspaceObservation)
  return input as unknown as ExperimentObservedOutput
}

/** Decode one controller's monotonic durations; no timestamp subtraction or duration synthesis. */
export function decodeExperimentMeasurement(value: unknown): ExperimentMeasurement {
  const input = object(boundedJson(value, { maxBytes: 4096, maxDepth: 4, maxNodes: 32 }), 'measurement')
  exact(input, ['version', 'unitKey', 'clock', 'environment', 'initMs', 'driveMs', 'shutdownMs', 'totalMs', 'overdueMs'], 'measurement')
  if (input.version !== 1 || input.clock !== 'performance.now') invalid('measurement-version-or-clock')
  text(input.unitKey, 'measurement-unit', 128)
  object(input.environment, 'measurement-environment')
  for (const field of ['initMs', 'driveMs', 'shutdownMs']) if (input[field] !== null) evidenceFinite(input[field], 'measurement-phase')
  evidenceFinite(input.totalMs, 'measurement-total'); evidenceFinite(input.overdueMs, 'measurement-overdue')
  return snapshotJson(input) as unknown as ExperimentMeasurement
}

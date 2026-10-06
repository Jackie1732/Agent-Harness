import { formatSessionAddress, formatSessionEventId, parseSessionAddress, parseSessionEventId, parseSessionId, sessionLogPosition } from '../session/ids.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import type { EvidenceFileDigest, EvidenceSessionCut } from './evidence-types.js'
import type { MetricsCoverage } from './metrics-types.js'
import type { ExperimentLimits } from './definition-types.js'
import { experimentArray as array, experimentDigest as digest, experimentInteger as integer, experimentKeys as exact,
  experimentObject as object, experimentRelativePath as path, experimentText as text, invalidExperiment as invalid } from './parsing.js'

export function evidenceBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label}-boolean`)
  return value
}
export function evidenceFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(`${label}-number`)
  return value
}
/** Decode a portable file identity; it grants no file access by itself. */
export function decodeEvidenceFileDigest(value: unknown): EvidenceFileDigest {
  const input = object(value, 'evidence-file'); exact(input, ['path', 'byteLength', 'sha256'], 'evidence-file')
  return { path: path(input.path, 'evidence-file-path'), byteLength: integer(input.byteLength, 'evidence-file-length', 0), sha256: digest(input.sha256, 'evidence-file-sha256') }
}
/** Decode exact framed-prefix provenance, allowing later physical frames outside this cut. */
export function decodeEvidenceSessionCut(value: unknown): EvidenceSessionCut {
  const input = object(value, 'evidence-cut')
  exact(input, ['sessionId', 'through', 'role', 'header', 'log', 'committedBytes', 'committedSha256', 'tail'], 'evidence-cut')
  const sessionId = parseSessionId(text(input.sessionId, 'cut-session', 36)), through = sessionLogPosition(integer(input.through, 'cut-through', 0))
  const header = decodeEvidenceFileDigest(input.header), log = decodeEvidenceFileDigest(input.log)
  if (header.path !== `sessions/${sessionId}/header.frame` || log.path !== `sessions/${sessionId}/events.log`) invalid('evidence-cut-file-identity')
  if (input.role !== 'selected' && input.role !== 'context') invalid('evidence-cut-role')
  const committedBytes = integer(input.committedBytes, 'committed-bytes', 0), committedSha256 = digest(input.committedSha256, 'committed-sha256')
  let tail: EvidenceSessionCut['tail'] = null
  if (input.tail !== null) {
    const raw = object(input.tail, 'evidence-tail'); exact(raw, ['byteOffset', 'byteLength', 'sha256'], 'evidence-tail')
    tail = { byteOffset: integer(raw.byteOffset, 'tail-offset', 0), byteLength: integer(raw.byteLength, 'tail-length'), sha256: digest(raw.sha256, 'tail-sha256') }
  }
  if (committedBytes > log.byteLength || committedBytes === log.byteLength && committedSha256 !== log.sha256
    || tail !== null && (tail.byteOffset < committedBytes || tail.byteOffset + tail.byteLength !== log.byteLength)) invalid('evidence-cut-byte-ranges')
  return { sessionId, through, role: input.role, header, log, committedBytes, committedSha256, tail }
}
/** The event address and identity must name the same owning Session. */
export function decodeEvidenceEventRef(value: unknown): WorkflowEventRef {
  const input = object(value, 'evidence-ref'); exact(input, ['address', 'eventId'], 'evidence-ref')
  const sessionId = parseSessionAddress(text(input.address, 'ref-address', 64)), event = parseSessionEventId(text(input.eventId, 'ref-event', 80))
  if (event.sessionId !== sessionId) invalid('evidence-ref-identity')
  return { address: formatSessionAddress(sessionId), eventId: formatSessionEventId(sessionId, event.sequence) }
}
/** Session counts use the inventory limit; failure reasons also include per-event Context checks and missing selections. */
export function decodeMetricsCoverage(value: unknown, limits: Pick<ExperimentLimits, 'maxSessionCount' | 'maxEvents'>): MetricsCoverage {
  const input = object(value, 'coverage'); exact(input, ['complete', 'expectedSessions', 'observedSessions', 'reasons'], 'coverage')
  const complete = evidenceBoolean(input.complete, 'coverage-complete')
  const expectedSessions = input.expectedSessions === null ? null : integer(input.expectedSessions, 'coverage-expected', 0)
  const observedSessions = integer(input.observedSessions, 'coverage-observed', 0)
  const reasons = array(input.reasons, 'coverage-reasons', limits.maxEvents + 2 * limits.maxSessionCount + 1).map(value => text(value, 'coverage-reason', 4096))
  if (observedSessions > limits.maxSessionCount || expectedSessions !== null && expectedSessions > limits.maxSessionCount
    || complete && (expectedSessions === null || expectedSessions !== observedSessions || reasons.length !== 0)) invalid('coverage-observation-counts')
  return { complete, expectedSessions, observedSessions, reasons }
}

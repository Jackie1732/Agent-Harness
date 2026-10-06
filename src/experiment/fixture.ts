import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'
import { ModelError } from '../model/errors.js'
import { parseModelInvocationId } from '../model/ids.js'
import { projectModelSession } from '../model/projection.js'
import { ScriptedModelProvider } from '../model/providers/scripted.js'
import { snapshotModelRequest } from '../model/request.js'
import { decodeNormalizedResult } from '../model/result-codec.js'
import type { ModelFrame, ModelRequest, NormalizedModelResult } from '../model/contract.js'
import { boundedJson, JsonBoundaryError, parseBoundedJson } from '../schema/bounded-json.js'
import { formatSessionAddress, formatSessionEventId, parseSessionEventId } from '../session/ids.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import type { EvidenceSessionCut } from './evidence-types.js'
import { decodeEvidenceSessionCut } from './evidence-codec-fields.js'
import { ExperimentError } from './errors.js'
import type { ExperimentOutcome } from './journal-types.js'
import type { ExportNormalizedCallFixtureInput, NormalizedCallFixture, NormalizedCallFixtureConsumption, NormalizedCallFixtureEntry,
  NormalizedCallFixtureExport, NormalizedCallFixtureLimits, NormalizedCallFixtureReplay,
  NormalizedCallFixtureReplayOptions, NormalizedCallFixtureResult } from './fixture-types.js'
import { experimentArray as array, experimentDigest as digest, experimentInteger as integer, experimentKeys as exact,
  experimentObject as object, experimentText as text, experimentUnique as unique, experimentJsonDigest, invalidExperiment as invalid } from './parsing.js'

/**
 * Export only successful local text calls; the source Reader supplies raw-byte provenance.
 * @param input Exact snapshot/cut, selected local invocation identities and export limits.
 * @returns Immutable result fixture, or an explicit unsupported source classification.
 */
export function exportNormalizedCallFixture(input: ExportNormalizedCallFixtureInput): NormalizedCallFixtureExport {
  if (input.source.sessionId !== input.snapshot.header.sessionId || input.source.through !== input.snapshot.localPosition) {
    throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'fixture-source-cut-mismatch')
  }
  const limit = fixtureJsonLimits(input.limits)
  if (input.invocationIds.length === 0 || input.invocationIds.length > input.limits.maxFixtureEntries) invalid('fixture-entry-count')
  unique(input.invocationIds, 'fixture-invocation')
  const state = projectModelSession(input.snapshot)
  const entries: NormalizedCallFixtureEntry[] = []
  for (const invocationId of input.invocationIds) {
    const invocation = state.invocations.find(item => item.invocationId === invocationId)
    if (invocation === undefined) return { status: 'unsupported', invocationId, reason: 'invocation-not-found' }
    if (invocation.state !== 'settled') return { status: 'unsupported', invocationId, reason: 'invocation-unsettled' }
    const settlement = invocation.settled.payload
    if (settlement.outcome !== 'completed' || settlement.external !== 'response-observed' || settlement.cleanup.status !== 'complete'
      || settlement.failure !== undefined || invocation.started === undefined) {
      return { status: 'unsupported', invocationId, reason: 'non-successful-call' }
    }
    const submission = invocation.prepared.payload.submission
    const reason = unsupportedContent(submission.request, settlement.result)
    if (reason !== null) return { status: 'unsupported', invocationId, reason }
    const address = input.snapshot.address
    entries.push({ invocationId, prepared: { address, eventId: invocation.prepared.stored.eventId },
      started: { address, eventId: invocation.started.stored.eventId }, settled: { address, eventId: invocation.settled.stored.eventId },
      preparedFingerprint: submission.fingerprint, request: submission.request, result: settlement.result as NormalizedCallFixtureResult,
      resultSha256: experimentJsonDigest(settlement.result) })
  }
  const fixture = { format: 'normalized-call-fixture/v1', exporterVersion: '1', source: input.source, entries }
  try { return { status: 'supported', fixture: boundedJson(fixture, limit) as unknown as NormalizedCallFixture } }
  catch (reason) { throw fixtureBoundaryError(reason) }
}

/**
 * Decode finite external JSON using the existing Model request/result decoders.
 * @param value Parsed external fixture JSON.
 * @param limits Inclusive fixture byte and entry ceilings.
 * @returns Validated immutable fixture, with original usage retained as source metadata.
 */
export function decodeNormalizedCallFixture(value: unknown, limits: NormalizedCallFixtureLimits): NormalizedCallFixture {
  try { return decodeFixture(boundedJson(value, fixtureJsonLimits(limits)), limits) }
  catch (reason) { throw fixtureBoundaryError(reason) }
}

/**
 * Apply the byte ceiling before JSON.parse, then decode the closed fixture format.
 * @param json External JSON document.
 * @param limits Inclusive fixture byte and entry ceilings.
 * @returns Validated immutable fixture.
 */
export function parseNormalizedCallFixture(json: string, limits: NormalizedCallFixtureLimits): NormalizedCallFixture {
  try { return decodeFixture(parseBoundedJson(json, fixtureJsonLimits(limits)), limits) }
  catch (reason) { throw fixtureBoundaryError(reason) }
}

/**
 * Replay final text with a fresh scripted binding; no original usage or wire identity is emitted.
 * @param options Validated fixture and explicit scripted Provider limits/identity.
 * @returns One Provider for one serial Runner, plus consumption observations. The caller disposes both.
 */
export function createNormalizedCallFixtureReplay(options: NormalizedCallFixtureReplayOptions): NormalizedCallFixtureReplay {
  let consumed = 0
  const match = (request: ModelRequest): NormalizedCallFixtureEntry => {
    const entry = options.fixture.entries[consumed]
    if (entry === undefined || !Buffer.from(canonicalJsonBytes(entry.request)).equals(Buffer.from(canonicalJsonBytes(request)))) {
      throw new ModelError('MODEL_BINDING_MISMATCH', entry === undefined ? 'normalized fixture is exhausted' : 'normalized fixture request differs')
    }
    return entry
  }
  const provider = new ScriptedModelProvider({ providerId: options.providerId, maxConcurrentExchanges: 1, streamLimits: options.streamLimits,
    onPrepare: request => { match(request) },
    script: submission => {
      const entry = match(submission.request)
      consumed += 1
      return textFrames(entry, consumed)
    } })
  const snapshot = (): NormalizedCallFixtureConsumption => Object.freeze({ total: options.fixture.entries.length, consumed,
    remaining: Object.freeze(options.fixture.entries.slice(consumed).map(entry => entry.invocationId)) })
  return Object.freeze({ provider, snapshot, finish: (outcome: ExperimentOutcome) => {
    const result = snapshot()
    if (outcome === 'completed' && result.remaining.length !== 0) throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'fixture-unconsumed')
    return result
  } })
}

function fixtureJsonLimits(limits: NormalizedCallFixtureLimits) {
  integer(limits.maxFixtureBytes, 'maxFixtureBytes'); integer(limits.maxFixtureEntries, 'maxFixtureEntries')
  return { maxBytes: limits.maxFixtureBytes, maxDepth: 64, maxNodes: limits.maxFixtureBytes }
}

function decodeFixture(value: JsonValue, limits: NormalizedCallFixtureLimits): NormalizedCallFixture {
  const input = object(value, 'fixture')
  exact(input, ['format', 'exporterVersion', 'source', 'entries'], 'fixture')
  if (input.format !== 'normalized-call-fixture/v1' || input.exporterVersion !== '1') invalid('fixture-format')
  const source = decodeEvidenceSessionCut(input.source)
  const entries = array(input.entries, 'fixture-entries', limits.maxFixtureEntries).map(value => decodeEntry(value, source))
  if (entries.length === 0) invalid('fixture-entry-count')
  unique(entries.map(entry => entry.invocationId), 'fixture-invocation')
  return snapshotJson({ format: input.format, exporterVersion: input.exporterVersion, source, entries }) as unknown as NormalizedCallFixture
}

function decodeEntry(value: unknown, source: EvidenceSessionCut): NormalizedCallFixtureEntry {
  const input = object(value, 'fixture-entry')
  exact(input, ['invocationId', 'prepared', 'started', 'settled', 'preparedFingerprint', 'request', 'result', 'resultSha256'], 'fixture-entry')
  const invocationId = parseModelInvocationId(text(input.invocationId, 'fixture-invocationId', 36))
  const prepared = decodeRef(input.prepared, source); const started = decodeRef(input.started, source); const settled = decodeRef(input.settled, source)
  if (parseSessionEventId(prepared.eventId).sequence >= parseSessionEventId(started.eventId).sequence
    || parseSessionEventId(started.eventId).sequence >= parseSessionEventId(settled.eventId).sequence) invalid('fixture-event-order')
  const request = snapshotModelRequest(input.request)
  const result = decodeNormalizedResult(input.result as JsonValue)
  if (unsupportedContent(request, result) !== null) invalid('fixture-unsupported-content')
  const resultSha256 = digest(input.resultSha256, 'fixture-resultSha256')
  if (experimentJsonDigest(result) !== resultSha256) invalid('fixture-result-digest')
  return { invocationId, prepared, started, settled, preparedFingerprint: digest(input.preparedFingerprint, 'fixture-preparedFingerprint'), request,
    result: result as NormalizedCallFixtureResult, resultSha256 }
}

function decodeRef(value: unknown, source: EvidenceSessionCut): WorkflowEventRef {
  const input = object(value, 'fixture-event'); exact(input, ['address', 'eventId'], 'fixture-event')
  const address = formatSessionAddress(source.sessionId)
  const parsed = parseSessionEventId(text(input.eventId, 'fixture-eventId', 80))
  if (input.address !== address || parsed.sessionId !== source.sessionId || parsed.sequence > source.through) invalid('fixture-event-cut')
  return { address, eventId: formatSessionEventId(parsed.sessionId, parsed.sequence) }
}

function unsupportedContent(request: ModelRequest, result: NormalizedModelResult): Extract<NormalizedCallFixtureExport, { status: 'unsupported' }>['reason'] | null {
  if (request.profile !== undefined) return 'request-profile'
  if (request.messages.some(message => message.role === 'assistant' && message.continuation !== undefined)) return 'request-continuation'
  if (!result.protocolComplete || result.stopReason === null || result.stopReason === 'length') return 'non-successful-call'
  if (result.blocks.some(block => block.kind !== 'text' || !block.complete)) return 'non-text-output'
  return null
}

async function* textFrames(entry: NormalizedCallFixtureEntry, ordinal: number): AsyncGenerator<ModelFrame> {
  yield { kind: 'message-start', reportedModel: entry.request.model, responseId: `normalized-fixture-${ordinal}` }
  for (const block of entry.result.blocks) {
    yield { kind: 'block-start', index: block.index, block: 'text' }
    yield { kind: 'text-delta', index: block.index, text: block.text }
    yield { kind: 'block-end', index: block.index }
  }
  yield { kind: 'complete', stopReason: entry.result.stopReason }
}

function fixtureBoundaryError(reason: unknown): ExperimentError {
  if (reason instanceof ExperimentError) return reason
  return new ExperimentError(reason instanceof JsonBoundaryError && ['bytes', 'depth', 'nodes'].includes(reason.reason)
    ? 'EXPERIMENT_LIMIT_EXCEEDED' : 'EXPERIMENT_INPUT_INVALID', 'fixture-json-invalid')
}

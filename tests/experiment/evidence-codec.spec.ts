import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hostConfig, hostSessionId } from '../host/fixtures.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { formatSessionAddress, formatSessionEventId, parseSessionId, sessionSequence } from '../../src/session/ids.js'
import { collectExperimentEvidence } from '../../src/experiment/evidence.js'
import { decodeExperimentEvidence, decodeExperimentMeasurement } from '../../src/experiment/evidence-codec.js'
import type { ExperimentEvidence } from '../../src/experiment/evidence-types.js'

const limits = { maxSessionCount: 20, maxEvents: 10000, maxEvidenceBytes: 8 * 1024 * 1024, maxMetricSamples: 64 }
let base: string, evidence: ExperimentEvidence
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'atomic-evidence-codec-'))
  const recipe = resolveHostConfig(decodeHostConfig(hostConfig(join(base, 'store')), base))
  await initializeHost(recipe)
  const host = await openHost(recipe)
  const receipt = await host.submitTask('writer', 'fixed observation')
  try { await host.run() } finally { await host.shutdown({ mode: 'drain' }) }
  evidence = (await collectExperimentEvidence({ recipe, limits, scope: 'unit-local/v1', mode: 'fixture', target: {
    kind: 'agent', sessionId: parseSessionId(hostSessionId), mediaType: 'text/plain', inputEventId: receipt.eventId, selector: { kind: 'root-final' } } })).evidence
})
afterAll(async () => { await rm(base, { recursive: true, force: true }) })

describe('persisted experiment evidence decoding', () => {
  it('round trips actual File-backed Host evidence without changing metadata or copying cloud usage into fixture execution', () => {
    const decoded = decodeExperimentEvidence(JSON.parse(JSON.stringify(evidence)), limits)
    expect(decoded).toEqual(evidence)
    expect(Object.isFrozen(decoded.metrics.counts)).toBe(true)
    expect(decoded.sessions[0]!.committedSha256).toBe(decoded.sessions[0]!.log.sha256)
    expect(decoded.output.status).toBe('available')
  })
  it('rejects unknown evidence versions, metric names and metric fields', () => {
    expect(() => decodeExperimentEvidence({ ...evidence, version: 2 }, limits)).toThrow('evidence-version')
    expect(() => decodeExperimentEvidence({ ...evidence, metrics: { ...evidence.metrics, counts: { ...evidence.metrics.counts, customCost: {} } } }, limits)).toThrow('metric-counts-fields')
    expect(() => decodeExperimentEvidence({ ...evidence, metrics: { ...evidence.metrics, tokens: { ...evidence.metrics.tokens,
      inputTokens: { ...evidence.metrics.tokens.inputTokens, actualCloudCost: 100 } } } }, limits)).toThrow('token-metric-fields')
  })
  it('keeps live/fixture mode and unit/historical scope consistent across evidence and its metrics', () => {
    expect(() => decodeExperimentEvidence({ ...evidence, mode: 'live' }, limits)).toThrow('evidence-metrics-mode-or-scope')
    expect(() => decodeExperimentEvidence({ ...evidence, scope: 'historical-local/v1' }, limits)).toThrow('evidence-metrics-mode-or-scope')
  })
  it('validates the selected session matrix, committed cuts and coverage instead of treating partial reads as complete', () => {
    expect(() => decodeExperimentEvidence({ ...evidence, selections: [] }, limits)).toThrow('evidence-selection-matrix')
    expect(() => decodeExperimentEvidence({ ...evidence, selections: [{ ...evidence.selections[0], through: 9999 }] }, limits)).toThrow('evidence-selection-cut')
    expect(() => decodeExperimentEvidence({ ...evidence, selections: [{ ...evidence.selections[0], through: null }] }, limits)).toThrow('evidence-selection-coverage')
    expect(() => decodeExperimentEvidence({ ...evidence, coverage: { ...evidence.coverage, observedSessions: 0 } }, limits)).toThrow('coverage-observation-counts')
  })
  it('rejects filesystem escape paths and paths that address another Session header', () => {
    const session = evidence.sessions[0]!
    expect(() => decodeExperimentEvidence({ ...evidence, sessions: [{ ...session, header: { ...session.header, path: '../outside' } }] }, limits)).toThrow('evidence-file-path-relative-path')
    expect(() => decodeExperimentEvidence({ ...evidence, sessions: [{ ...session, header: { ...session.header, path: 'sessions/22222222-2222-4222-8222-222222222222/header.frame' } }] }, limits)).toThrow('evidence-cut-file-identity')
    expect(() => decodeExperimentEvidence({ ...evidence, sessions: [{ ...session, committedSha256: 'b'.repeat(64) }] }, limits)).toThrow('evidence-cut-byte-ranges')
  })
  it('checks source output byte identity and ensures event addresses agree with their identifiers', () => {
    if (evidence.output.status !== 'available') throw new Error('fixture output absent')
    const output = evidence.output
    expect(() => decodeExperimentEvidence({ ...evidence, output: { ...output, byteLength: output.byteLength + 1 } }, limits)).toThrow('output-byte-identity')
    expect(() => decodeExperimentEvidence({ ...evidence, output: { ...output, sha256: 'b'.repeat(64) } }, limits)).toThrow('output-byte-identity')
    expect(() => decodeExperimentEvidence({ ...evidence, output: { ...output, sources: [] } }, limits)).toThrow('output-source-missing')
    expect(() => decodeExperimentEvidence({ ...evidence, target: null }, limits)).toThrow('output-source-missing')
    const other = parseSessionId('22222222-2222-4222-8222-222222222222')
    expect(() => decodeExperimentEvidence({ ...evidence, output: { ...output, sources: [{ address: formatSessionAddress(other), eventId: output.sources[0]!.eventId }] } }, limits)).toThrow('evidence-ref-identity')
    expect(() => decodeExperimentEvidence({ ...evidence, target: { ...evidence.target, inputEventId: formatSessionEventId(other, sessionSequence(1)) } }, limits)).toThrow('target-input-session')
  })
  it('rejects forged complete counters, token coverage ratios and sample accounting', () => {
    const count = evidence.metrics.counts['model.started']
    expect(() => decodeExperimentEvidence({ ...evidence, metrics: { ...evidence.metrics, counts: { ...evidence.metrics.counts,
      'model.started': { ...count, knownSubtotal: count.knownSubtotal + 1 } } } }, limits)).toThrow('count-completeness')
    expect(() => decodeExperimentEvidence({ ...evidence, metrics: { ...evidence.metrics, tokens: { ...evidence.metrics.tokens,
      inputTokens: { ...evidence.metrics.tokens.inputTokens, ratio: 500 } } } }, limits)).toThrow('token-completeness')
    expect(() => decodeExperimentEvidence({ ...evidence, metrics: { ...evidence.metrics, counts: { ...evidence.metrics.counts,
      'model.started': { ...count, basis: { ...count.basis, truncated: !count.basis.truncated } } } } }, limits)).toThrow('metric-sample-accounting')
  })
  it('enforces byte, source-event and shared metric sample budgets', () => {
    expect(() => decodeExperimentEvidence(evidence, { ...limits, maxEvidenceBytes: 1 })).toThrow('evidence-json-invalid')
    expect(() => decodeExperimentEvidence(evidence, { ...limits, maxEvents: 1 })).toThrow('evidence-source-budget')
    expect(() => decodeExperimentEvidence(evidence, { ...limits, maxMetricSamples: 0 })).toThrow()
  })
})

describe('controller monotonic measurement decoding', () => {
  const observation = { version: 1, unitKey: 'unit-1', clock: 'performance.now', environment: { origin: 'synthetic-duration-fixture' }, initMs: null, driveMs: 0.125, shutdownMs: 4.5, totalMs: 8.5, overdueMs: 0 }
  it('retains fractional millisecond readings and unavailable phases without deriving another duration', () => {
    const decoded = decodeExperimentMeasurement(observation)
    expect(decoded).toEqual(observation); expect(Object.isFrozen(decoded)).toBe(true)
  })
  it('rejects wrong clocks, unknown fields, missing phases and invalid numeric values', () => {
    expect(() => decodeExperimentMeasurement({ ...observation, clock: 'Date.now' })).toThrow('measurement-version-or-clock')
    expect(() => decodeExperimentMeasurement({ ...observation, startTimestamp: 100 })).toThrow('measurement-fields')
    expect(() => decodeExperimentMeasurement({ ...observation, driveMs: -1 })).toThrow('measurement-phase-number')
    expect(() => decodeExperimentMeasurement({ ...observation, totalMs: Number.NaN })).toThrow()
    const { shutdownMs: _, ...missing } = observation
    expect(() => decodeExperimentMeasurement(missing)).toThrow('measurement-fields')
  })
})

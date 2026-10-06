import { describe, expect, it } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { compareCrossExperimentResults, compareExperimentResults, selectPrimaryExperimentEvaluations } from '../../src/experiment/comparison.js'
import { collectExperimentMetrics } from '../../src/experiment/metrics.js'
import { comparisonFixture, comparisonPlan } from './comparison-fixture.js'

describe('paired experiment descriptions at exact evidence cuts', () => {
  it('retains every planned pair and separates business completion from quality denominators', async () => {
    const fixture = await comparisonFixture(await comparisonPlan(), unit => unit.variantKey === 'a'
      ? unit.repetition === 1 ? { outcome: 'failed', quality: 'pass', time: 10 } : { quality: 'missing', time: 20 }
      : unit.repetition === 1 ? { quality: 'fail', time: 15 } : { outcome: 'timed-out', quality: 'unavailable', time: null })
    try {
      const result = compareExperimentResults({ results: fixture.results(), comparisonKey: 'a-versus-b', numericMetrics: ['time.totalMs'] })
      expect(result.status).toBe('provisional'); expect(result.rows).toHaveLength(2)
      expect(result.summary.a).toMatchObject({ planned: 2, started: 2, sealed: 2, completed: 1, plannedPassRate: 0.5, evaluatedPassRate: 1,
        evaluationCoverage: 0.5, completedRate: 0.5, sealedCoverage: 1, qualityCounts: { pass: 1, 'not-evaluated': 1 } })
      expect(result.summary.b).toMatchObject({ plannedPassRate: 0, evaluatedPassRate: 0, evaluationCoverage: 0.5, completedRate: 0.5 })
      expect(result.summary.qualityCross).toEqual({ bothPass: 0, aPassBFail: 1, aFailBPass: 0, bothFail: 0, missing: 1 })
      expect(result.numeric[0]!.delta.completePairs).toEqual({ count: 1, knownSubtotal: 5, mean: 5, min: 5, max: 5 })
      expect(result.numeric[0]!.cases[0]).toMatchObject({ missingPairs: 1, missingA: 0, missingB: 1 })
      expect(result.rows[1]!.b.business).toBe('timed-out')
    } finally { await fixture.dispose() }
  })

  it('computes B-A on complete repeats and then gives Cases equal weight', async () => {
    const fixture = await comparisonFixture(await comparisonPlan(true), unit => ({ time: unit.caseKey === 'question'
      ? (unit.variantKey === 'a' ? 10 : 20) * unit.repetition
      : unit.repetition === 2 ? null : unit.variantKey === 'a' ? 100 : 130 }))
    try {
      const metric = compareExperimentResults({ results: fixture.results(), comparisonKey: 'a-versus-b', numericMetrics: ['time.totalMs'] }).numeric[0]!
      expect(metric.a.units).toMatchObject({ count: 3, knownSubtotal: 130, mean: 130 / 3 })
      expect(metric.a.caseBalanced).toEqual({ validCases: 2, missingCases: 0, mean: 57.5 })
      expect(metric.delta.completePairs).toMatchObject({ count: 3, mean: 20 })
      expect(metric.delta.caseBalanced).toEqual({ validCases: 2, missingCases: 0, mean: 22.5 })
      expect(metric.cases.map(item => item.delta.mean)).toEqual([15, 30])
      expect(metric.cases[1]!.missingPairs).toBe(1)
    } finally { await fixture.dispose() }
  })

  it('a numeric comparison with no valid measurements has null means/min/max and no invented pairs', async () => {
    const fixture = await comparisonFixture(await comparisonPlan(true), () => ({ time: null, quality: 'missing' }))
    try {
      const result = compareExperimentResults({ results: fixture.results(), comparisonKey: 'a-versus-b', numericMetrics: ['time.totalMs'] })
      const metric = result.numeric[0]!
      expect(result.rows).toHaveLength(4)
      expect(metric.a.units).toEqual({ count: 0, knownSubtotal: 0, mean: null, min: null, max: null })
      expect(metric.delta.completePairs).toEqual(metric.a.units)
      expect(metric.delta.caseBalanced).toEqual({ validCases: 0, missingCases: 2, mean: null })
      expect(result.summary.a.evaluatedPassRate).toBeNull(); expect(result.summary.a.evaluationCoverage).toBe(0)
    } finally { await fixture.dispose() }
  })

  it('preserves known partial Provider token subtotals without treating them as complete numeric samples', async () => {
    const fixture = await comparisonFixture(await comparisonPlan())
    const empty = collectExperimentMetrics({ scope: 'unit-local/v1', mode: 'fixture', snapshots: [], selectedSessionIds: [], maxMetricSamples: 0,
      coverage: { complete: true, expectedSessions: 0, observedSessions: 0, reasons: [] } })
    try {
      const observations = fixture.observations.map(item => ({ ...item, metrics: { ...empty,
        tokens: { ...empty.tokens, inputTokens: { ...empty.tokens.inputTokens, total: null, knownSubtotal: 30, status: 'incomplete' as const } } } }))
      const result = compareExperimentResults({ results: { ...fixture.results(), observations }, comparisonKey: 'a-versus-b', numericMetrics: ['token.inputTokens'] })
      expect(result.numeric[0]!.a.units).toEqual({ count: 0, knownSubtotal: 60, mean: null, min: null, max: null })
      expect(result.numeric[0]!.delta.completePairs.count).toBe(0)
      expect(result.rows[0]!.a.numericReasons['token.inputTokens']).toBe('metric-incomplete')
    } finally { await fixture.dispose() }
  })

  it('fixed primary missing choices survive a later successful evaluation of the same exact key', async () => {
    const fixture = await comparisonFixture(await comparisonPlan(), unit => ({ quality: unit.variantKey === 'a' && unit.repetition === 1 ? 'missing' : 'pass' }))
    try {
      await fixture.finalize()
      const before = compareExperimentResults({ results: fixture.results(), comparisonKey: 'a-versus-b', numericMetrics: [] })
      await fixture.evaluatePending()
      const after = compareExperimentResults({ results: fixture.results(), comparisonKey: 'a-versus-b', numericMetrics: [] })
      expect(after.status).toBe('primary-fixed')
      expect(after.summary.a.plannedPassRate).toBe(0.5)
      expect(after.rows[0]!.a.evaluation).toEqual({ status: 'not-evaluated', score: null, event: null })
      expect(after.summary).toEqual(before.summary)
      expect(after.arms[0]!.journalCut).toBeGreaterThan(after.arms[0]!.selectionCut)
    } finally { await fixture.dispose() }
  })

  it('requires the primary report cut to include the already-started units and their dispositions', async () => {
    const fixture = await comparisonFixture(await comparisonPlan())
    try {
      await expect(fixture.journal.recordReport({ reportKey: 'early', kind: 'primary', cut: 1,
        report: { path: 'reports/early.json', byteLength: 0, sha256: 'a'.repeat(64) },
        selections: fixture.results().plan.units.map(unit => ({ unitKey: unit.unitKey, evaluationEvent: null })) })).rejects.toThrow('primary-report-before-disposition')
      expect(fixture.journal.snapshot().reports).toHaveLength(0)
    } finally { await fixture.dispose() }
  })

  it('keeps observed completed business under unresolved closure out of execution completion rates', async () => {
    const fixture = await comparisonFixture(await comparisonPlan(), () => ({ unresolved: true, outcome: 'completed' }))
    try {
      await fixture.finalize()
      const result = compareExperimentResults({ results: fixture.results(), comparisonKey: 'a-versus-b', numericMetrics: [] })
      expect(result.summary.a).toMatchObject({ unresolved: 1, completed: 0, completedRate: 0, businessCounts: { completed: 1 } })
      expect(result.summary.b).toMatchObject({ started: 0, notStarted: 2, notRunCounts: { 'not-run-after-interruption': 2 } })
    } finally { await fixture.dispose() }
  })

  it('namespaces identical unit keys across experiments and rejects incompatible repetition matrices', async () => {
    const a = await comparisonFixture(await comparisonPlan(), () => ({ time: 5 })), b = await comparisonFixture(await comparisonPlan(), () => ({ time: 7 }))
    const incompatible = await comparisonFixture(await comparisonPlan(false, 3))
    try {
      await a.finalize(); await b.finalize()
      const result = compareCrossExperimentResults({ a: a.results(), variantA: 'a', b: b.results(), variantB: 'a', comparisonKey: 'between', numericMetrics: ['time.totalMs'] })
      expect(result.rows[0]!.a.unitKey).toBe(result.rows[0]!.b.unitKey)
      expect(result.rows[0]!.a.experimentId).not.toBe(result.rows[0]!.b.experimentId)
      expect(result.rows[0]!.a.evaluation.event!.address).not.toBe(result.rows[0]!.b.evaluation.event!.address)
      expect(result.numeric[0]!.delta.completePairs.mean).toBe(2)
      expect(() => compareCrossExperimentResults({ a: a.results(), variantA: 'a', b: incompatible.results(), variantB: 'a', comparisonKey: 'between', numericMetrics: [] })).toThrow('comparison-incompatible-dataset-or-mode')
    } finally { await a.dispose(); await b.dispose(); await incompatible.dispose() }
  })

  it('rejects a primary report that substitutes an evaluation reference from another experiment', async () => {
    const a = await comparisonFixture(await comparisonPlan()), b = await comparisonFixture(await comparisonPlan())
    try {
      const selections = selectPrimaryExperimentEvaluations(b.results())
      const current = a.results()
      await expect(a.journal.recordReport({ reportKey: 'foreign', kind: 'primary', cut: current.cut, report: { path: 'reports/foreign.json', sha256: 'a'.repeat(64), byteLength: 0 }, selections: selections as unknown as readonly JsonObject[] })).rejects.toThrow('primary-report-evaluation-reference')
      expect(a.journal.snapshot().reports).toHaveLength(0)
    } finally { await a.dispose(); await b.dispose() }
  })
})

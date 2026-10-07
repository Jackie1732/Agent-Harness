import { appendFile, cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject, JsonValue } from '../../src/foundation/json.js'
import { compareExperiments, evaluateExperiment, registerDerivedEvidence } from '../../src/experiment/analysis.js'
import { publishExperimentArtifact, readExperimentArtifact } from '../../src/experiment/artifacts.js'
import { experimentCliErrorExitCode, runExperimentCli } from '../../src/experiment/cli.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { collectExperimentEvidence } from '../../src/experiment/evidence.js'
import type { ExperimentEvidence } from '../../src/experiment/evidence-types.js'
import { reportExperiment } from '../../src/experiment/report.js'
import { runExperiment } from '../../src/experiment/runner.js'
import { runExperimentUnit } from '../../src/experiment/runner-unit.js'
import { experimentJsonDigest } from '../../src/experiment/parsing.js'
import { createExperimentStorage, openExperimentStorage, readExperimentStorage } from '../../src/experiment/storage.js'
import { experimentDefinition } from './definition-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-analysis-')); roots.push(root)
  const base = experimentDefinition(root)
  const plan = await planExperiment({ ...base, repetitions: 1,
    variants: (base.variants as readonly JsonObject[]).map(variant => ({ ...variant,
      recipe: { ...(variant.recipe as JsonObject), members: ((variant.recipe as JsonObject).members as readonly JsonObject[])
        .map(member => ({ ...member, model: { ...(member.model as JsonObject), text: '42' } })) } })) })
  await runExperiment(plan)
  const state = (await readExperimentStorage(plan.storage.controlRoot)).state!
  return { root, plan, state, unit: state.units[0]!, planned: plan.units[0]! }
}

async function cliFailure(args: readonly string[]) {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(); stdin.end()
  stdout.resume()
  try { await runExperimentCli(args, { stdin, stdout, stderr }, {}) }
  catch (error) { return { error, exit: experimentCliErrorExitCode(error) } }
  throw new Error('expected incomplete evidence')
}

async function cliResult(args: readonly string[]) {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(); stdin.end()
  let output = ''
  stdout.on('data', chunk => { output += String(chunk) })
  const exit = await runExperimentCli(args, { stdin, stdout, stderr }, {})
  return { exit, result: JSON.parse(output) as JsonObject }
}

async function reviewedCopy(f: Awaited<ReturnType<typeof fixture>>, evidenceKey: string) {
  const original = JSON.parse(await readFile(join(f.plan.storage.controlRoot, f.unit.sealed!.payload.evidence.path), 'utf8')) as ExperimentEvidence
  const copyRoot = join(f.root, evidenceKey)
  await cp(join(f.planned.hostRoot, 'sessions'), join(copyRoot, 'sessions'), { recursive: true })
  const collected = await collectExperimentEvidence({ recipe: { ...f.planned.recipe, storage: { ...f.planned.recipe.storage, root: copyRoot } },
    limits: f.plan.evidenceLimits, scope: 'unit-local/v1', mode: 'fixture', target: original.target! })
  const registered = await registerDerivedEvidence(f.plan.storage.controlRoot, { unitKey: f.planned.unitKey, evidenceKey, evidence: collected.evidence,
    derivedFrom: { kind: 'reviewed-copy/v1', actionKey: evidenceKey, originalDisposition: { address: f.plan.experimentId, eventId: f.unit.sealed!.stored.eventId },
      originalEvidence: f.unit.sealed!.payload.evidence, recipeDigest: f.unit.started!.payload.recipeDigest, sourceRoot: copyRoot } })
  await evaluateExperiment(f.plan.storage.controlRoot, { unitKey: f.planned.unitKey, evidenceKey })
  return { copyRoot, registered }
}

async function damage(path: string, kind: 'changed' | 'missing' | 'digest-changed') {
  if (kind === 'changed') await appendFile(path, Buffer.from([1]))
  else if (kind === 'missing') await unlink(path)
  else {
    const bytes = await readFile(path)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    await writeFile(path, bytes)
  }
}

describe('analysis source authentication and CLI outcomes', () => {
  it.each(['missing-source', 'changed-source', 'missing-metadata', 'changed-metadata'] as const)('marks a posthoc report with %s incomplete without changing its primary result', async kind => {
    const f = await fixture(), root = f.plan.storage.controlRoot, copy = await reviewedCopy(f, 'copy')
    const comparison = await compareExperiments(root, { comparisonKey: 'a-versus-b' })
    const primary = f.state.reports[0]!.payload.report, bytes = await readFile(join(root, primary.path))
    const path = kind.endsWith('source') ? join(copy.copyRoot, 'sessions', f.planned.recipe.members[0]!.sessionId, 'events.log')
      : join(root, copy.registered.payload.evidence.path)
    await damage(path, kind.startsWith('missing') ? 'missing' : 'digest-changed')
    const report = await reportExperiment(root, { reportKey: 'copy-review', kind: 'posthoc' })
    expect(report.complete).toBe(false)
    expect(report.artifactFailures).toEqual([{ unitKey: f.planned.unitKey, evidenceKey: 'copy', reason: expect.any(String) }])
    const stored = JSON.parse(await readFile(join(root, report.reference.path), 'utf8')) as JsonObject
    expect(stored.artifactFailures).toEqual(report.artifactFailures)
    expect((await cliResult(['report', '--root', root, '--report-key', 'copy-review', '--kind', 'posthoc'])).exit).toBe(2)
    expect((await reportExperiment(root, { reportKey: 'primary', kind: 'primary' })).complete).toBe(true)
    expect((await compareExperiments(root, { comparisonKey: 'a-versus-b' })).summary).toEqual(comparison.summary)
    expect(await readFile(join(root, primary.path))).toEqual(bytes)
  }, 30_000)

  it('authenticates an existing posthoc report at its own cut and preserves its published bytes', async () => {
    const f = await fixture(), root = f.plan.storage.controlRoot, included = await reviewedCopy(f, 'included')
    const original = await reportExperiment(root, { reportKey: 'fixed-review', kind: 'posthoc' })
    const bytes = await readFile(join(root, original.reference.path))
    const late = await reviewedCopy(f, 'late')
    expect(late.registered.stored.sequence).toBeGreaterThan(original.cut)
    await unlink(join(root, late.registered.payload.evidence.path))
    const before = (await readExperimentStorage(root)).state!
    const unchanged = await reportExperiment(root, { reportKey: 'fixed-review', kind: 'posthoc' })
    expect(unchanged.complete).toBe(true)
    expect(unchanged.reference).toEqual(original.reference)
    expect((await cliResult(['report', '--root', root, '--report-key', 'fixed-review', '--kind', 'posthoc'])).exit).toBe(0)
    expect((await readExperimentStorage(root)).state).toEqual(before)
    expect(await readFile(join(root, original.reference.path))).toEqual(bytes)
    const current = await reportExperiment(root, { reportKey: 'current-review', kind: 'posthoc' })
    expect(current.complete).toBe(false)
    expect(current.artifactFailures).toEqual([{ unitKey: f.planned.unitKey, evidenceKey: 'late', reason: 'referenced-artifact-missing' }])
    await unlink(join(root, included.registered.payload.evidence.path))
    const fixed = await reportExperiment(root, { reportKey: 'fixed-review', kind: 'posthoc' })
    expect(fixed.complete).toBe(false)
    expect(fixed.artifactFailures).toEqual([{ unitKey: f.planned.unitKey, evidenceKey: 'included', reason: 'referenced-artifact-missing' }])
    expect(await readFile(join(root, original.reference.path))).toEqual(bytes)
    expect((await reportExperiment(root, { reportKey: 'primary', kind: 'primary' })).complete).toBe(true)
  }, 30_000)

  it('keeps later sealed units outside an existing provisional posthoc report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-provisional-report-')); roots.push(root)
    const plan = await planExperiment({ ...experimentDefinition(root), repetitions: 1 }), first = plan.units[0]!
    const storage = await createExperimentStorage(plan)
    try {
      const result = await runExperimentUnit(plan, first, storage, {})
      expect(result.evidence?.coverage.complete).toBe(true)
      const evidence = await publishExperimentArtifact(plan.storage.controlRoot, `runs/${first.unitKey}/evidence.json`,
        result.evidence as unknown as JsonValue, plan.evidenceLimits.maxEvidenceBytes)
      await storage.journal.sealUnit({ unitKey: first.unitKey, outcome: result.outcome, reason: result.reason, closure: 'confirmed',
        evidenceDigest: experimentJsonDigest(result.evidence as unknown as JsonValue), evidence, measurement: null })
    } finally { await storage.dispose() }
    await evaluateExperiment(plan.storage.controlRoot, { unitKey: first.unitKey })
    const provisional = await reportExperiment(plan.storage.controlRoot, { reportKey: 'provisional', kind: 'posthoc' })
    expect(provisional.complete).toBe(true)
    const bytes = await readFile(join(plan.storage.controlRoot, provisional.reference.path))
    await runExperiment(plan, { continueUnstarted: true })
    const continued = (await readExperimentStorage(plan.storage.controlRoot)).state!, late = continued.units[1]!
    expect(late.sealed!.stored.sequence).toBeGreaterThan(provisional.cut)
    await unlink(join(plan.storage.controlRoot, late.sealed!.payload.evidence.path))
    const fixed = await reportExperiment(plan.storage.controlRoot, { reportKey: 'provisional', kind: 'posthoc' })
    expect(fixed.complete).toBe(true)
    expect(fixed.artifactFailures).toEqual([])
    expect(fixed.reference).toEqual(provisional.reference)
    expect(fixed.cut).toBe(provisional.cut)
    expect(fixed.selections).toEqual(provisional.selections)
    expect(fixed.state).toEqual(continued)
    const cli = await cliResult(['report', '--root', plan.storage.controlRoot, '--report-key', 'provisional', '--kind', 'posthoc'])
    expect(cli.result.complete).toBe(true)
    expect(cli.exit).toBe(2)
    expect(await readFile(join(plan.storage.controlRoot, provisional.reference.path))).toEqual(bytes)
    const current = await reportExperiment(plan.storage.controlRoot, { reportKey: 'current', kind: 'posthoc' })
    expect(current.complete).toBe(false)
    expect(current.artifactFailures).toEqual([{ unitKey: late.unitKey, reason: 'referenced-artifact-missing' }])
    expect((await cliResult(['verify', '--root', plan.storage.controlRoot])).exit).toBe(2)
  }, 30_000)

  it('verify and report keep an evidence JSON byte limit as an error with exit 1', async () => {
    const { plan, state, unit } = await fixture(), root = plan.storage.controlRoot
    const path = join(root, unit.sealed!.payload.evidence.path), original = await readFile(path)
    await appendFile(path, Buffer.alloc(plan.evidenceLimits.maxEvidenceBytes + 1 - original.byteLength))
    for (const command of [['verify', '--root', root], ['report', '--root', root, '--report-key', 'oversized', '--kind', 'posthoc']]) {
      const failure = await cliFailure(command)
      expect(failure.error).toMatchObject({ code: 'EXPERIMENT_LIMIT_EXCEEDED', message: 'experiment-file-bytes-limit' })
      expect(failure.exit).toBe(1)
    }
    expect((await readExperimentStorage(root)).state).toEqual(state)
  }, 30_000)

  it.each(['changed', 'missing'] as const)('classifies %s original Session files as incomplete for comparison, evaluation and fixture export', async kind => {
    const { plan, state, planned } = await fixture(), root = plan.storage.controlRoot
    const sessionId = planned.recipe.members[0]!.sessionId
    await damage(join(planned.hostRoot, 'sessions', sessionId, 'events.log'), kind)
    const commands = [
      ['compare', '--root', root, '--comparison', 'a-versus-b'],
      ['evaluate', '--root', root, '--unit', planned.unitKey],
      ['export-fixture', '--root', root, '--unit', planned.unitKey, '--session', sessionId, '--output', join(root, 'unused-fixture.json')],
    ]
    for (const command of commands) {
      const failure = await cliFailure(command)
      expect(failure.exit).toBe(2)
      expect(failure.error).toMatchObject({ code: 'EXPERIMENT_EVIDENCE_INCOMPLETE' })
    }
    expect((await readExperimentStorage(root)).state).toEqual(state)
  }, 30_000)

  it.each(['changed', 'missing', 'digest-changed'] as const)('does not use %s sealed evidence JSON in comparison, evaluation or fixture export', async kind => {
    const { plan, state, unit, planned } = await fixture(), root = plan.storage.controlRoot
    const sessionId = planned.recipe.members[0]!.sessionId
    await damage(join(root, unit.sealed!.payload.evidence.path), kind)
    for (const command of [
      ['compare', '--root', root, '--comparison', 'a-versus-b'],
      ['evaluate', '--root', root, '--unit', planned.unitKey],
      ['export-fixture', '--root', root, '--unit', planned.unitKey, '--session', sessionId, '--output', join(root, 'unused-fixture.json')],
    ]) {
      const failure = await cliFailure(command)
      expect(failure.exit).toBe(2)
      expect(failure.error).toMatchObject({ code: 'EXPERIMENT_EVIDENCE_INCOMPLETE',
        message: kind === 'missing' ? 'referenced-artifact-missing' : 'referenced-artifact-changed' })
    }
    expect((await readExperimentStorage(root)).state).toEqual(state)
  }, 30_000)

  it.each(['changed', 'missing'] as const)('does not evaluate %s reviewed-copy Session files or change the primary comparison', async kind => {
    const { root, plan, state, unit, planned } = await fixture(), controlRoot = plan.storage.controlRoot
    const original = JSON.parse(await readFile(join(controlRoot, unit.sealed!.payload.evidence.path), 'utf8'))
    const copyRoot = join(root, 'review-store')
    await cp(join(planned.hostRoot, 'sessions'), join(copyRoot, 'sessions'), { recursive: true })
    const collected = await collectExperimentEvidence({ recipe: { ...planned.recipe, storage: { ...planned.recipe.storage, root: copyRoot } },
      limits: plan.evidenceLimits, scope: 'unit-local/v1', mode: 'fixture', target: original.target })
    await registerDerivedEvidence(controlRoot, { unitKey: planned.unitKey, evidenceKey: 'copy', evidence: collected.evidence,
      derivedFrom: { kind: 'reviewed-copy/v1', actionKey: 'review-copy', originalDisposition: { address: plan.experimentId, eventId: unit.sealed!.stored.eventId },
        originalEvidence: unit.sealed!.payload.evidence, recipeDigest: unit.started!.payload.recipeDigest, sourceRoot: copyRoot } })
    const before = (await readExperimentStorage(controlRoot)).state!
    const comparison = await compareExperiments(controlRoot, { comparisonKey: 'a-versus-b' })
    await damage(join(copyRoot, 'sessions', planned.recipe.members[0]!.sessionId, 'events.log'), kind)
    let failure: unknown
    try { await evaluateExperiment(controlRoot, { unitKey: planned.unitKey, evidenceKey: 'copy' }) }
    catch (error) { failure = error }
    expect(failure).toMatchObject({ code: 'EXPERIMENT_EVIDENCE_INCOMPLETE', message: 'evaluation-source-changed' })
    expect(experimentCliErrorExitCode(failure)).toBe(2)
    expect((await readExperimentStorage(controlRoot)).state).toEqual(before)
    expect((await compareExperiments(controlRoot, { comparisonKey: 'a-versus-b' })).summary).toEqual(comparison.summary)
    expect(before.reports[0]!.payload).toEqual(state.reports[0]!.payload)
  }, 30_000)

  it.each(['missing', 'digest-changed'] as const)('rejects %s derived evidence JSON while preserving the original comparison', async kind => {
    const { plan, state, unit, planned } = await fixture(), root = plan.storage.controlRoot
    const evidence = JSON.parse(await readFile(join(root, unit.sealed!.payload.evidence.path), 'utf8'))
    const registered = await registerDerivedEvidence(root, { unitKey: planned.unitKey, evidenceKey: 'same-source', evidence,
      derivedFrom: { kind: 'reviewed-copy/v1', actionKey: 'same-source-review', originalDisposition: { address: plan.experimentId, eventId: unit.sealed!.stored.eventId },
        originalEvidence: unit.sealed!.payload.evidence, recipeDigest: unit.started!.payload.recipeDigest, sourceRoot: planned.hostRoot } })
    const before = (await readExperimentStorage(root)).state!, comparison = await compareExperiments(root, { comparisonKey: 'a-versus-b' })
    await damage(join(root, registered.payload.evidence.path), kind)
    let failure: unknown
    try { await evaluateExperiment(root, { unitKey: planned.unitKey, evidenceKey: 'same-source' }) }
    catch (error) { failure = error }
    expect(failure).toMatchObject({ code: 'EXPERIMENT_EVIDENCE_INCOMPLETE',
      message: kind === 'missing' ? 'referenced-artifact-missing' : 'referenced-artifact-changed' })
    expect(experimentCliErrorExitCode(failure)).toBe(2)
    expect((await readExperimentStorage(root)).state).toEqual(before)
    expect((await compareExperiments(root, { comparisonKey: 'a-versus-b' })).summary).toEqual(comparison.summary)
    expect(before.reports[0]!.payload).toEqual(state.reports[0]!.payload)
  }, 30_000)

  it('returns incomplete when an existing primary report file is missing without publishing a replacement', async () => {
    const { plan, state } = await fixture(), root = plan.storage.controlRoot
    await unlink(join(root, state.reports[0]!.payload.report.path))
    const failure = await cliFailure(['report', '--root', root, '--report-key', 'primary', '--kind', 'primary'])
    expect(failure.error).toMatchObject({ code: 'EXPERIMENT_EVIDENCE_INCOMPLETE', message: 'referenced-artifact-missing' })
    expect(failure.exit).toBe(2)
    expect((await readExperimentStorage(root)).state).toEqual(state)
  }, 30_000)

  it('keeps an authenticated artifact read beyond its byte limit as an explicit error with exit 1', async () => {
    const { plan, state, unit } = await fixture(), root = plan.storage.controlRoot
    let failure: unknown
    try { await readExperimentArtifact(root, unit.sealed!.payload.evidence, 1) }
    catch (error) { failure = error }
    expect(failure).toMatchObject({ code: 'EXPERIMENT_LIMIT_EXCEEDED', message: 'experiment-file-bytes-limit' })
    expect(experimentCliErrorExitCode(failure)).toBe(1)
    expect((await readExperimentStorage(root)).state).toEqual(state)
  }, 30_000)

  it('keeps a changed evaluation payload under the same exact key as a conflict with exit 1', async () => {
    const { plan, state } = await fixture(), storage = await openExperimentStorage(plan.storage.controlRoot)
    try {
      const prior = state.evaluations[0]!.payload
      const rules = prior.result.rules as readonly JsonObject[]
      let failure: unknown
      try { await storage.journal.settleEvaluation({ ...prior, result: { ...prior.result,
        rules: rules.map((rule, index) => index === 0 ? { ...rule, reason: 'different-result' } : rule) } }) }
      catch (error) { failure = error }
      expect(failure).toMatchObject({ code: 'EXPERIMENT_CONFLICT', message: 'journal-command-content-changed' })
      expect(experimentCliErrorExitCode(failure)).toBe(1)
      expect(storage.journal.snapshot()).toEqual(state)
    } finally { await storage.dispose() }
  }, 30_000)
})

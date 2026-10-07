import { appendFile, cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { compareExperiments, evaluateExperiment, registerDerivedEvidence } from '../../src/experiment/analysis.js'
import { readExperimentArtifact } from '../../src/experiment/artifacts.js'
import { experimentCliErrorExitCode, runExperimentCli } from '../../src/experiment/cli.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { collectExperimentEvidence } from '../../src/experiment/evidence.js'
import { runExperiment } from '../../src/experiment/runner.js'
import { openExperimentStorage, readExperimentStorage } from '../../src/experiment/storage.js'
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

import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { runExperimentCli, experimentCliDiagnostic, experimentCliErrorExitCode } from '../../src/experiment/cli.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { decodeExperimentPlan } from '../../src/experiment/plan-codec.js'
import { ExperimentError } from '../../src/experiment/errors.js'
import * as runner from '../../src/experiment/runner.js'
import * as analysis from '../../src/experiment/analysis.js'
import { readExperimentStorage } from '../../src/experiment/storage.js'
import { experimentDefinition } from './definition-fixture.js'

const roots: string[] = []
async function directory() { const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-cli-')); roots.push(root); return root }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function streams() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  let text = ''
  stdout.on('data', chunk => { text += String(chunk) }); stdin.end()
  return { stdin, stdout, stderr, output: () => text, json: () => JSON.parse(text) }
}

function answered(root: string): JsonObject {
  const base = experimentDefinition(root)
  return { ...base, variants: (base.variants as readonly JsonObject[]).map((variant, index) => ({ ...variant,
    recipe: { ...(variant.recipe as JsonObject), members: ((variant.recipe as JsonObject).members as readonly JsonObject[])
      .map(member => ({ ...member, model: { ...(member.model as JsonObject), text: index === 0 ? '42' : '41' } })) } })) }
}

async function fingerprint(root: string): Promise<readonly string[]> {
  const result: string[] = []
  async function visit(path: string, prefix: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = prefix + entry.name, absolute = join(path, entry.name)
      if (entry.isDirectory()) await visit(absolute, `${key}/`)
      else result.push(`${key}:${createHash('sha256').update(await readFile(absolute)).digest('hex')}`)
    }
  }
  await visit(root, ''); return result.sort()
}

describe('finite experiment CLI', () => {
  it('documents all ten commands without reading configuration or credentials', async () => {
    for (const args of [[], ['--help'], ['help'], ['run', '--help']]) {
      const io = streams()
      expect(await runExperimentCli(args, io, {})).toBe(0)
      for (const command of ['plan', 'run', 'inspect', 'verify', 'evaluate', 'compare', 'report', 'export-fixture', 'close', 'register-evidence'])
        expect(io.output()).toContain(command)
    }
  })

  it.each([
    ['unknown'], ['inspect', '--unexpected'], ['inspect', '--root'], ['inspect', '--root', 'x', '--root', 'y'],
    ['help', '--unexpected'], ['run', '--root', 'x', '--plan', 'y', '--mode', 'fixture'], ['run', '--root', 'x'],
    ['run', '--root', 'x', '--mode', 'invalid'], ['run', '--root', 'x', '--mode', 'fixture', '--expected-token', 't'],
    ['close', '--root', 'x'],
  ])('rejects incomplete, duplicate, and undeclared arguments: %j', async (...args) => {
    await expect(runExperimentCli(args, streams())).rejects.toMatchObject({ code: 'EXPERIMENT_INPUT_INVALID' })
  })

  it('inspect and verify preserve a missing root and return incomplete status', async () => {
    const root = join(await directory(), 'absent')
    const inspected = streams(), verified = streams()
    expect(await runExperimentCli(['inspect', '--root', root], inspected, {})).toBe(2)
    expect(inspected.json()).toMatchObject({ kind: 'uninitialized', state: null })
    expect(await runExperimentCli(['verify', '--root', root], verified, {})).toBe(2)
    expect(verified.json()).toMatchObject({ complete: false, reasons: ['experiment-uninitialized'] })
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('freezes a plan without creating runtime roots and never overwrites a prior output', async () => {
    const root = await directory(), path = join(root, 'definition.json'), output = join(root, 'plan.json')
    await writeFile(path, JSON.stringify(answered(root)))
    const io = streams()
    expect(await runExperimentCli(['plan', '--definition', path, '--output', output], io)).toBe(0)
    const bytes = await readFile(output), plan = decodeExperimentPlan(JSON.parse(bytes.toString('utf8')))
    expect(io.json()).toMatchObject({ kind: 'planned', planDigest: plan.planDigest, output: { path: output } })
    expect(plan.units.map(unit => unit.variantKey)).toEqual(['a', 'b', 'b', 'a'])
    for (const path of [plan.storage.controlRoot, plan.storage.workspaceRoot]) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(runExperimentCli(['plan', '--definition', path, '--output', output], streams())).rejects.toMatchObject({ code: 'EXPERIMENT_CONFLICT' })
    expect(await readFile(output)).toEqual(bytes)
  })

  it('runs, reads, evaluates, compares, reports, exports, registers, and closes a builtin matrix', async () => {
    const root = await directory(), plan = await planExperiment(answered(root)), planPath = join(root, 'plan.json')
    await writeFile(planPath, JSON.stringify(plan))
    const run = streams()
    expect(await runExperimentCli(['run', '--plan', planPath, '--mode', 'fixture'], run, {})).toBe(0)
    expect(run.json()).toMatchObject({ finalized: true, stoppedBy: 'completed' })
    const beforeReaders = await fingerprint(root)
    const inspect = streams(), verify = streams(), compare = streams()
    expect(await runExperimentCli(['inspect', '--root', plan.storage.controlRoot], inspect, {})).toBe(0)
    expect(await runExperimentCli(['verify', '--root', plan.storage.controlRoot], verify, {})).toBe(0)
    expect(verify.json().complete).toBe(true)
    expect(await runExperimentCli(['compare', '--root', plan.storage.controlRoot, '--comparison', 'a-versus-b'], compare, {})).toBe(0)
    expect(compare.json()).toMatchObject({ status: 'primary-fixed', summary: { a: { qualityCounts: { pass: 2 } }, b: { qualityCounts: { fail: 2 } } } })
    expect(await fingerprint(root)).toEqual(beforeReaders)
    const first = plan.units[0]!, primaryRef = (await readExperimentStorage(plan.storage.controlRoot)).state!.reports[0]!.payload.report
    const primaryPath = join(plan.storage.controlRoot, primaryRef.path), primaryBytes = await readFile(primaryPath)
    const evaluated = streams()
    expect(await runExperimentCli(['evaluate', '--root', plan.storage.controlRoot, '--unit', first.unitKey], evaluated)).toBe(0)
    expect(evaluated.json().overall).toBe('pass')
    expect(await runExperimentCli(['report', '--root', plan.storage.controlRoot, '--report-key', 'review', '--kind', 'posthoc'], streams())).toBe(0)
    const exported = streams(), fixturePath = join(root, 'fixture.json')
    expect(await runExperimentCli(['export-fixture', '--root', plan.storage.controlRoot, '--unit', first.unitKey,
      '--session', first.recipe.members[0]!.sessionId, '--output', fixturePath], exported)).toBe(0)
    expect(JSON.parse(await readFile(fixturePath, 'utf8'))).toMatchObject({ format: 'normalized-call-fixture/v1', entries: [expect.any(Object)] })
    const sourcePath = join(root, 'source.json')
    const originalUnit = (await readExperimentStorage(plan.storage.controlRoot)).state!.units.find(unit => unit.unitKey === first.unitKey)!
    await writeFile(sourcePath, JSON.stringify({ kind: 'reviewed-copy/v1', actionKey: 'review-copy',
      originalDisposition: { address: plan.experimentId, eventId: originalUnit.sealed!.stored.eventId },
      originalEvidence: originalUnit.sealed!.payload.evidence, recipeDigest: originalUnit.started!.payload.recipeDigest, sourceRoot: first.hostRoot }))
    const registered = streams()
    expect(await runExperimentCli(['register-evidence', '--root', plan.storage.controlRoot, '--unit', first.unitKey,
      '--evidence-key', 'review-copy', '--evidence', join(plan.storage.controlRoot, `runs/${first.unitKey}/evidence.json`), '--source', sourcePath], registered)).toBe(0)
    expect(registered.json().payload.evidenceKey).toBe('review-copy')
    const forgedPath = join(root, 'forged.json'), forged = JSON.parse(await readFile(join(plan.storage.controlRoot, `runs/${first.unitKey}/evidence.json`), 'utf8'))
    forged.metrics.counts['model.started'].value++
    forged.metrics.counts['model.started'].knownSubtotal++
    await writeFile(forgedPath, JSON.stringify(forged))
    await writeFile(sourcePath, JSON.stringify({ kind: 'reviewed-copy/v1', actionKey: 'forged-copy',
      originalDisposition: { address: plan.experimentId, eventId: originalUnit.sealed!.stored.eventId },
      originalEvidence: originalUnit.sealed!.payload.evidence, recipeDigest: originalUnit.started!.payload.recipeDigest, sourceRoot: first.hostRoot }))
    const beforeRejectedRegistration = await fingerprint(plan.storage.controlRoot)
    await expect(runExperimentCli(['register-evidence', '--root', plan.storage.controlRoot, '--unit', first.unitKey,
      '--evidence-key', 'forged-copy', '--evidence', forgedPath, '--source', sourcePath], streams())).rejects.toThrow('derived-evidence-not-reproducible')
    expect(await fingerprint(plan.storage.controlRoot)).toEqual(beforeRejectedRegistration)
    const closed = streams()
    expect(await runExperimentCli(['close', '--root', plan.storage.controlRoot, '--predecessor-stopped'], closed)).toBe(0)
    expect(closed.json().state.finalized.payload.reportKey).toBe('primary')
    expect(await readFile(primaryPath)).toEqual(primaryBytes)
  }, 30_000)

  it('requires explicit frozen mode and excludes executable callback bindings from the CLI', async () => {
    const root = await directory(), base = answered(root), path = join(root, 'definition.json')
    const plan = await planExperiment(base), planPath = join(root, 'plan.json')
    await writeFile(planPath, JSON.stringify(plan))
    await expect(runExperimentCli(['run', '--plan', planPath, '--mode', 'live'], streams())).rejects.toThrow('cli-mode-differs-from-plan')
    await writeFile(path, JSON.stringify({ ...base, variants: (base.variants as readonly JsonObject[]).map(variant => ({ ...variant,
      fixture: { kind: 'programmatic', fixtureKey: 'callback', version: '1', sourceSha256: 'a'.repeat(64) } })) }))
    await expect(runExperimentCli(['plan', '--definition', path], streams())).rejects.toThrow('cli-fixture-binding-unsupported')
    await expect(stat(plan.storage.controlRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('passes only frozen credential references and rejects missing active credentials before creating storage', async () => {
    const root = await directory(), base = answered(root)
    const definition = { ...base, runPolicy: { ...(base.runPolicy as JsonObject), mode: 'live' },
      variants: (base.variants as readonly JsonObject[]).map(variant => ({ ...variant, recipe: { ...(variant.recipe as JsonObject),
        members: ((variant.recipe as JsonObject).members as readonly JsonObject[]).map(member => {
          const { text: _text, ...model } = member.model as JsonObject
          return { ...member, model: { ...model, kind: 'deepseek', endpoint: 'https://api.example.invalid', credentialRef: 'EXPERIMENT_TEST_CREDENTIAL' } }
        }) } })) }
    const plan = await planExperiment(definition), planPath = join(root, 'plan.json')
    await writeFile(planPath, JSON.stringify(plan))
    const args = ['run', '--plan', planPath, '--mode', 'live']
    await expect(runExperimentCli(args, streams(), {})).rejects.toThrow('credential-reference-unavailable')
    await expect(stat(plan.storage.controlRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    const execute = vi.spyOn(runner, 'runExperiment').mockRejectedValue(new ExperimentError('EXPERIMENT_INPUT_INVALID', 'test-stopped-before-host'))
    const io = streams()
    await expect(runExperimentCli(args, io, { EXPERIMENT_TEST_CREDENTIAL: 'private-credential', UNUSED_CREDENTIAL: 'ignored' })).rejects.toThrow('test-stopped-before-host')
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ planDigest: plan.planDigest }), expect.objectContaining({ mode: 'live', credentials: { EXPERIMENT_TEST_CREDENTIAL: 'private-credential' } }))
    expect(io.output()).not.toContain('private-credential')
    await expect(stat(plan.storage.controlRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps an originally missing primary evaluation incomplete after later evaluation', async () => {
    const root = await directory(), base = answered(root), plan = await planExperiment({ ...base, repetitions: 1,
      variants: [(base.variants as readonly JsonObject[])[0]!], comparisons: [] }), planPath = join(root, 'plan.json')
    await writeFile(planPath, JSON.stringify(plan))
    const settle = vi.spyOn(analysis, 'evaluateStoredExperimentUnit').mockRejectedValue(new ExperimentError('EXPERIMENT_INPUT_INVALID', 'test-evaluator-interruption'))
    await expect(runExperimentCli(['run', '--plan', planPath, '--mode', 'fixture'], streams())).rejects.toThrow('test-evaluator-interruption')
    settle.mockRestore()
    const before = await readExperimentStorage(plan.storage.controlRoot)
    expect(before.state!.units[0]!.sealed?.payload.outcome).toBe('completed')
    expect(await runExperimentCli(['close', '--root', plan.storage.controlRoot, '--predecessor-stopped'], streams())).toBe(2)
    expect(await runExperimentCli(['evaluate', '--root', plan.storage.controlRoot, '--unit', plan.units[0]!.unitKey], streams())).toBe(0)
    expect(await runExperimentCli(['inspect', '--root', plan.storage.controlRoot], streams())).toBe(2)
    expect(await runExperimentCli(['verify', '--root', plan.storage.controlRoot], streams())).toBe(2)
    const after = await readExperimentStorage(plan.storage.controlRoot)
    expect(after.state!.reports[0]!.payload.selections[0]!.evaluationEvent).toBeNull()
  }, 30_000)

  it('returns success for complete malformed JSON quality failures', async () => {
    const root = await directory(), base = answered(root), dataset = base.dataset as JsonObject
    const definition = { ...base, repetitions: 1, variants: [(base.variants as readonly JsonObject[])[1]!], comparisons: [],
      dataset: { ...dataset, cases: (dataset.cases as readonly JsonObject[]).map(item => ({ ...item, output: { outputKey: 'answer', mediaType: 'application/json' } })) },
      evaluators: [{ evaluatorKey: 'exact', version: '1', implementationVersion: 'rules/v1', rules: [{ ruleKey: 'answer', kind: 'json-equals', normalize: [], expected: 42 }] }] }
    const raw = (definition.variants as readonly JsonObject[])[0]!, recipe = raw.recipe as JsonObject
    const invalidDefinition = { ...definition, variants: [{ ...raw, recipe: { ...recipe,
      members: (recipe.members as readonly JsonObject[]).map(member => ({ ...member, model: { ...(member.model as JsonObject), text: 'invalid-json' } })) } }] }
    const invalidPlan = await planExperiment(invalidDefinition), path = join(root, 'plan.json')
    await writeFile(path, JSON.stringify(invalidPlan))
    expect(await runExperimentCli(['run', '--plan', path, '--mode', 'fixture'], streams())).toBe(0)
    const read = await readExperimentStorage(invalidPlan.storage.controlRoot)
    expect(read.state!.units[0]!.sealed?.payload.outcome).toBe('completed')
    expect(read.state!.evaluations[0]!.payload.result.overall).toBe('fail')
    expect(await runExperimentCli(['inspect', '--root', invalidPlan.storage.controlRoot], streams())).toBe(0)
  }, 30_000)

  it('reports changed raw evidence as incomplete without rewriting the original primary report', async () => {
    const root = await directory(), base = answered(root), plan = await planExperiment({ ...base, repetitions: 1,
      variants: [(base.variants as readonly JsonObject[])[0]!], comparisons: [] }), path = join(root, 'plan.json')
    await writeFile(path, JSON.stringify(plan))
    expect(await runExperimentCli(['run', '--plan', path, '--mode', 'fixture'], streams())).toBe(0)
    const unit = plan.units[0]!, primaryRef = (await readExperimentStorage(plan.storage.controlRoot)).state!.reports[0]!.payload.report
    const primaryPath = join(plan.storage.controlRoot, primaryRef.path), primaryBytes = await readFile(primaryPath)
    await appendFile(join(unit.hostRoot, 'sessions', unit.recipe.members[0]!.sessionId, 'events.log'), Buffer.from([1]))
    const review = streams()
    expect(await runExperimentCli(['report', '--root', plan.storage.controlRoot, '--report-key', 'changed-source', '--kind', 'posthoc'], review)).toBe(2)
    expect(review.json().complete).toBe(false)
    expect(review.json().artifactFailures.length).toBeGreaterThan(0)
    const before = (await readExperimentStorage(plan.storage.controlRoot)).state!.position
    expect(await runExperimentCli(['report', '--root', plan.storage.controlRoot, '--report-key', 'primary', '--kind', 'primary'], streams())).toBe(2)
    expect((await readExperimentStorage(plan.storage.controlRoot)).state!.position).toBe(before)
    expect(await readFile(primaryPath)).toEqual(primaryBytes)
    expect(await runExperimentCli(['verify', '--root', plan.storage.controlRoot], streams())).toBe(2)
    const originalUnit = (await readExperimentStorage(plan.storage.controlRoot)).state!.units[0]!, sourcePath = join(root, 'changed-source.json')
    await writeFile(sourcePath, JSON.stringify({ kind: 'reviewed-copy/v1', actionKey: 'changed-source',
      originalDisposition: { address: plan.experimentId, eventId: originalUnit.sealed!.stored.eventId },
      originalEvidence: originalUnit.sealed!.payload.evidence, recipeDigest: originalUnit.started!.payload.recipeDigest, sourceRoot: unit.hostRoot }))
    const journalBefore = (await readExperimentStorage(plan.storage.controlRoot)).state!.position
    await expect(runExperimentCli(['register-evidence', '--root', plan.storage.controlRoot, '--unit', unit.unitKey,
      '--evidence-key', 'changed-source', '--evidence', join(plan.storage.controlRoot, originalUnit.sealed!.payload.evidence.path), '--source', sourcePath], streams()))
      .rejects.toMatchObject({ code: 'EXPERIMENT_EVIDENCE_INCOMPLETE', message: 'derived-source-changed' })
    expect((await readExperimentStorage(plan.storage.controlRoot)).state!.position).toBe(journalBefore)
  }, 30_000)

  it('diagnostics omit causes, input bodies, and unowned error text', () => {
    const error = new ExperimentError('EXPERIMENT_INPUT_INVALID', 'cli-option-unknown', { credential: 'private' }, { cause: new Error('private-path') })
    expect(experimentCliDiagnostic(error)).toEqual({ code: 'EXPERIMENT_INPUT_INVALID', message: 'cli-option-unknown' })
    expect(experimentCliDiagnostic(new Error('private-body'))).toEqual({ code: 'EXPERIMENT_INTERNAL_ERROR', message: 'experiment-operation-failed' })
    expect(experimentCliErrorExitCode(error)).toBe(1)
    expect(experimentCliErrorExitCode(new ExperimentError('EXPERIMENT_EVIDENCE_INCOMPLETE', 'source-cut-missing'))).toBe(2)
    expect(experimentCliErrorExitCode(new ExperimentError('EXPERIMENT_COMMIT_UNKNOWN', 'journal-append-failed-admission-closed'))).toBe(2)
  })
})

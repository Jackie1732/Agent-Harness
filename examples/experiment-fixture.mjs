import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareExperiments, planExperiment, runExperiment, verifyExperiment } from '../dist/experiment/index.js'

/**
 * One complete Case, two independent scripted variants, and two alternating paired repetitions.
 * @param root - Parent of distinct experiment-control and authorized-workspace roots.
 * @returns An editable JSON definition; no Host or storage is initialized.
 */
export async function createExperimentFixtureDefinition(root) {
  const recipe = JSON.parse(await readFile(new URL('./host-config.json', import.meta.url), 'utf8'))
  recipe.storage.root = join(root, 'template')
  recipe.members = [recipe.members[0]]
  recipe.members[0].spec.nativeActions = []
  recipe.members[0].spec.peers = []
  recipe.members[0].spec.messages = []
  recipe.routes = [recipe.routes[0]]
  recipe.channels = []; recipe.messages = []
  return {
    version: 1, experimentKey: 'fixed-answer-comparison',
    dataset: { datasetKey: 'one-question', version: '1', cases: [{ caseKey: 'question', task: 'Return the answer as a decimal number.',
      materials: [{ logicalPath: 'notes.txt', mediaType: 'text/plain', source: { kind: 'inline', text: 'The answer is 42.\n' }, expectedSha256: null }],
      output: { outputKey: 'answer', mediaType: 'text/plain' }, primaryEvaluatorKey: 'exact-answer' }] },
    variants: ['a', 'b'].map((variantKey, index) => {
      const variantRecipe = structuredClone(recipe)
      variantRecipe.members[0].model.text = index === 0 ? '42' : '41'
      return { variantKey, recipe: variantRecipe, factors: { fixedReply: variantRecipe.members[0].model.text }, fixture: { kind: 'builtin' },
        bindings: [{ caseKey: 'question', kind: 'agent', inputMode: 'inline', agentKey: 'writer', materials: [], output: { kind: 'root-final' } }] }
    }),
    comparisons: [{ comparisonKey: 'a-versus-b', variantA: 'a', variantB: 'b' }], repetitions: 2, order: 'alternating-pairs',
    evaluators: [{ evaluatorKey: 'exact-answer', version: '1', implementationVersion: 'rules/v1',
      rules: [{ ruleKey: 'exact', kind: 'text-exact', normalize: [], expected: '42' }] }],
    runPolicy: { mode: 'fixture', maxDriveCalls: 16, maxWallTimeMs: 10_000, onCaseFailure: 'continue' },
    storage: { controlRoot: join(root, 'control'), workspaceRoot: join(root, 'work'), maxRecordBytes: 2 * 1024 * 1024 },
    evidenceLimits: { maxCases: 10, maxVariants: 4, maxUnits: 40, maxInputBytes: 1024 * 1024, maxPlanBytes: 2 * 1024 * 1024,
      maxRecipeBytes: 1024 * 1024, maxSessionCount: 100, maxEvents: 10_000, maxEvidenceBytes: 8 * 1024 * 1024, maxMetricSamples: 10_000,
      maxReportBytes: 2 * 1024 * 1024, maxFixtureEntries: 100, maxFixtureBytes: 2 * 1024 * 1024 },
    provenance: { purpose: 'offline execution and evidence verification', liveModelEffect: 'not-run' },
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-example-'))
  try {
    const plan = await planExperiment(await createExperimentFixtureDefinition(root))
    const execution = await runExperiment(plan, { mode: 'fixture' })
    const verified = await verifyExperiment(plan.storage.controlRoot)
    const comparison = await compareExperiments(plan.storage.controlRoot,
      { comparisonKey: 'a-versus-b', numericMetrics: ['count.model.started', 'time.totalMs'] })
    assert.equal(execution.finalized, true); assert.equal(verified.complete, true)
    assert.deepEqual(plan.units.map(unit => unit.variantKey), ['a', 'b', 'b', 'a'])
    assert.equal(comparison.summary.a.qualityCounts.pass, 2)
    assert.equal(comparison.summary.b.qualityCounts.fail, 2)
    assert.equal(comparison.numeric[0].delta.completePairs.mean, 0)
    console.log(JSON.stringify({ example: 'experiment-fixture', mode: 'fixture', units: execution.units.length,
      order: plan.units.map(unit => unit.variantKey), verified: verified.complete,
      comparison: { status: comparison.status, summary: comparison.summary, numeric: comparison.numeric },
      liveModelEffect: 'not-run', inference: 'descriptive-only' }))
  } finally { await rm(root, { recursive: true, force: true }) }
}

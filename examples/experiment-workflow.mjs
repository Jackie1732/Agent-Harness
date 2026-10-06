import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareExperiments, planExperiment, runExperiment, verifyExperiment } from '../dist/experiment/index.js'
import { FileSessionBackend, hostRuntimeEventCatalog, parseSessionId, SessionRepository } from '../dist/index.js'
import { createExperimentFixtureDefinition } from './experiment-fixture.mjs'
import { workflowConfig, resolveWorkflowConfig } from './workflow-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-workflow-'))
try {
  const base = await createExperimentFixtureDefinition(root), recipe = await workflowConfig(join(root, 'template'))
  const answer = 'Logged messages connect independent sessions.'
  recipe.members[0].model.text = answer
  recipe.members[1].model.text = 'Each receiving session retains its own durable state.'
  resolveWorkflowConfig(recipe)
  const variants = [1, 2].map(concurrency => {
    const configured = structuredClone(recipe)
    configured.workflows.maxBusinessConcurrency = concurrency
    return { variantKey: concurrency === 1 ? 'serial' : 'parallel', recipe: configured,
      factors: { maxBusinessConcurrency: concurrency }, fixture: { kind: 'builtin' },
      bindings: [{ caseKey: 'research', kind: 'workflow', inputMode: 'inline', materials: [], workflowKey: 'research',
        durationMs: 60_000, nodeTasks: [{ nodeKey: 'writer', prefix: 'First independent evidence: ' }, { nodeKey: 'reviewer', prefix: 'Second independent evidence: ' }],
        output: { kind: 'workflow-artifact', nodeKey: 'writer', artifactName: 'writer' } }] }
  })
  const definition = { ...base, experimentKey: 'workflow-concurrency-comparison',
    dataset: { datasetKey: 'session-research', version: '1', cases: [{ caseKey: 'research', task: 'Take independent notes on the fixed material.',
      materials: [{ logicalPath: 'evidence.txt', mediaType: 'text/plain', source: { kind: 'inline',
        text: 'Research topic: communication between agents with separate durable sessions.\n' }, expectedSha256: null }],
      output: { outputKey: 'evidence', mediaType: 'text/plain' }, primaryEvaluatorKey: 'exact-evidence' }] },
    variants, comparisons: [{ comparisonKey: 'serial-versus-parallel', variantA: 'serial', variantB: 'parallel' }],
    evaluators: [{ evaluatorKey: 'exact-evidence', version: '1', implementationVersion: 'rules/v1',
      rules: [{ ruleKey: 'evidence', kind: 'text-exact', normalize: [], expected: answer }] }],
  }
  const plan = await planExperiment(definition), execution = await runExperiment(plan, { mode: 'fixture' })
  assert.equal(execution.finalized, true)
  assert.deepEqual(plan.units.map(unit => unit.variantKey), ['serial', 'parallel', 'parallel', 'serial'])
  assert.equal(new Set(plan.units.map(unit => unit.hostRoot)).size, 4)
  assert.equal(new Set(plan.units.map(unit => unit.workspaceRoot)).size, 4)
  const observations = []
  for (const unit of plan.units) {
    const state = execution.units.find(observed => observed.unitKey === unit.unitKey)
    assert.equal(state.sealed?.payload.outcome, 'completed')
    const evidence = JSON.parse(await readFile(join(plan.storage.controlRoot, state.sealed.payload.evidence.path), 'utf8'))
    assert.equal(evidence.output.status, 'available'); assert.equal(evidence.output.text, answer)
    assert.equal(evidence.sessions.length, 3)
    assert.equal(evidence.metrics.counts['model.started'].value, 2)
    assert.equal(evidence.metrics.counts['workflow.accepted'].value, 2)
    assert.equal(evidence.metrics.counts['workflow.closed'].value, 1)
    const measurement = JSON.parse(await readFile(join(plan.storage.controlRoot, state.sealed.payload.measurement.path), 'utf8'))
    assert.equal(measurement.environment.nodeVersion, process.version)
    assert.equal(measurement.environment.sourceArtifactRelationship, 'unverified')
    const reader = new SessionRepository({ backend: new FileSessionBackend(unit.recipe.storage),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: unit.recipe.storage.maxLineageDepth })
    try {
      for (const member of unit.recipe.members) {
        const snapshot = await reader.read(parseSessionId(member.sessionId))
        const prepared = snapshot.history.at(-1).events.find(event => event.stored.type === 'model/invocation-prepared')
        assert.match(JSON.stringify(prepared.payload.submission.request), /Research topic: communication between agents with separate durable sessions\./)
      }
    } finally { await reader.dispose() }
    observations.push({ variant: unit.variantKey, outcome: state.sealed.payload.outcome, sessions: evidence.sessions.length,
      models: evidence.metrics.counts['model.started'].value, accepted: evidence.metrics.counts['workflow.accepted'].value })
  }
  const verified = await verifyExperiment(plan.storage.controlRoot)
  assert.equal(verified.complete, true)
  const comparison = await compareExperiments(plan.storage.controlRoot,
    { comparisonKey: 'serial-versus-parallel', numericMetrics: ['count.model.started', 'count.workflow.accepted', 'time.totalMs'] })
  assert.equal(comparison.status, 'primary-fixed')
  assert.equal(comparison.summary.a.qualityCounts.pass, 2); assert.equal(comparison.summary.b.qualityCounts.pass, 2)
  assert.equal(comparison.numeric[0].delta.completePairs.mean, 0)
  assert.equal(comparison.numeric[1].delta.completePairs.mean, 0)
  console.log(JSON.stringify({ example: 'experiment-workflow', mode: 'fixture', verified: true,
    order: plan.units.map(unit => unit.variantKey), observations,
    comparison: { status: comparison.status, summary: comparison.summary, numeric: comparison.numeric },
    liveModelEffect: 'not-run', inference: 'descriptive-only' }))
} finally { await rm(root, { recursive: true, force: true }) }

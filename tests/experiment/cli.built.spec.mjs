import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createExperimentFixtureDefinition } from '../../examples/experiment-fixture.mjs'
import { decodeExperimentPlan, createNormalizedCallFixtureReplay } from '../../dist/experiment/index.js'
import { createDurableEventCatalog, MemorySessionBackend, modelSessionEventDefinitions, SessionModelRunner, SessionRepository } from '../../dist/index.js'

const bin = fileURLToPath(new URL('../../dist/host/bin.js', import.meta.url))
const packageVersion = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version
function cli(args, expected = 0) {
  const result = spawnSync(process.execPath, [bin, 'experiment', ...args],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, expected, `${result.stderr}\n${result.stdout}`)
  return result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout) : result.stdout
}

test('built experiment CLI preserves argument, missing-root, and Host version behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-built-input-'))
  try {
    assert.match(cli(['--help']), /register-evidence/)
    cli(['inspect', '--root', root, '--unknown'], 1)
    const missing = join(root, 'missing')
    assert.equal(cli(['inspect', '--root', missing], 2).kind, 'uninitialized')
    assert.equal(cli(['verify', '--root', missing], 2).complete, false)
    await assert.rejects(stat(missing), { code: 'ENOENT' })
    const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    assert.equal(version.status, 0, version.stderr); assert.equal(version.stdout.trim(), packageVersion)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('built experiment CLI completes all ten commands with frozen, reproducible evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-built-run-'))
  try {
    const definitionPath = join(root, 'definition.json'), planPath = join(root, 'plan.json')
    await writeFile(definitionPath, JSON.stringify(await createExperimentFixtureDefinition(root)))
    const planned = cli(['plan', '--definition', definitionPath, '--output', planPath])
    const plan = decodeExperimentPlan(JSON.parse(await readFile(planPath, 'utf8')))
    assert.equal(planned.planDigest, plan.planDigest)
    assert.deepEqual(plan.units.map(unit => unit.variantKey), ['a', 'b', 'b', 'a'])
    assert.equal(cli(['run', '--plan', planPath, '--mode', 'fixture']).finalized, true)
    const journalPath = join(plan.storage.controlRoot, 'journal-store', 'sessions', plan.journalSessionId, 'events.log')
    const readerBytes = await readFile(journalPath)
    const inspected = cli(['inspect', '--root', plan.storage.controlRoot])
    assert.equal(inspected.kind, 'initialized')
    assert.equal(cli(['verify', '--root', plan.storage.controlRoot]).complete, true)
    const comparison = cli(['compare', '--root', plan.storage.controlRoot, '--comparison', 'a-versus-b'])
    assert.equal(comparison.status, 'primary-fixed')
    assert.equal(comparison.summary.a.qualityCounts.pass, 2); assert.equal(comparison.summary.b.qualityCounts.fail, 2)
    assert.deepEqual(await readFile(journalPath), readerBytes)
    const first = plan.units[0], primaryPath = join(plan.storage.controlRoot, inspected.state.reports[0].payload.report.path), primaryBytes = await readFile(primaryPath)
    assert.equal(cli(['evaluate', '--root', plan.storage.controlRoot, '--unit', first.unitKey]).overall, 'pass')
    assert.equal(cli(['report', '--root', plan.storage.controlRoot, '--report-key', 'built-review', '--kind', 'posthoc']).finalized, true)
    const fixturePath = join(root, 'fixture.json')
    assert.equal(cli(['export-fixture', '--root', plan.storage.controlRoot, '--unit', first.unitKey,
      '--session', first.recipe.members[0].sessionId, '--output', fixturePath]).status, 'supported')
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
    assert.equal(fixture.format, 'normalized-call-fixture/v1'); assert.equal(fixture.entries.length, 1)
    assert.match(JSON.stringify(fixture.entries[0].request), /The answer is 42\./)
    const measurement = JSON.parse(await readFile(join(plan.storage.controlRoot, `runs/${first.unitKey}/measurement.json`), 'utf8'))
    assert.equal(measurement.clock, 'performance.now')
    assert.equal(measurement.environment.nodeVersion, process.version)
    assert.equal(measurement.environment.sourceArtifactRelationship, 'unverified')
    const replay = createNormalizedCallFixtureReplay({ fixture, providerId: 'built-normalized-replay',
      streamLimits: first.recipe.members[0].model.streamLimits })
    const repository = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: plan.storage.maxRecordBytes }),
      catalog: createDurableEventCatalog(modelSessionEventDefinitions), maxLineageDepth: 0 })
    const session = await repository.create(), model = new SessionModelRunner({ session, provider: replay.provider,
      limits: first.recipe.members[0].model.runnerLimits })
    try {
      const settled = await model.invoke(fixture.entries[0].request)
      assert.equal(settled.payload.outcome, 'completed')
      assert.deepEqual(settled.payload.result.blocks, fixture.entries[0].result.blocks)
      assert.equal(settled.payload.result.usage.completeness, 'unknown')
      assert.deepEqual(replay.finish('completed'), { total: 1, consumed: 1, remaining: [] })
    } finally { await model.dispose(); await replay.provider.dispose(); await repository.dispose() }
    const sourcePath = join(root, 'source.json')
    const originalUnit = inspected.state.units.find(unit => unit.unitKey === first.unitKey)
    await writeFile(sourcePath, JSON.stringify({ kind: 'reviewed-copy/v1', actionKey: 'built-copy',
      originalDisposition: { address: plan.experimentId, eventId: originalUnit.sealed.stored.eventId },
      originalEvidence: originalUnit.sealed.payload.evidence, recipeDigest: originalUnit.started.payload.recipeDigest, sourceRoot: first.hostRoot }))
    assert.equal(cli(['register-evidence', '--root', plan.storage.controlRoot, '--unit', first.unitKey,
      '--evidence-key', 'built-copy', '--evidence', join(plan.storage.controlRoot, `runs/${first.unitKey}/evidence.json`), '--source', sourcePath]).payload.evidenceKey, 'built-copy')
    assert.equal(cli(['close', '--root', plan.storage.controlRoot, '--predecessor-stopped']).state.finalized.payload.reportKey, 'primary')
    assert.deepEqual(await readFile(primaryPath), primaryBytes)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('built CLI classifies unavailable authenticated evidence separately from execution errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-built-authentication-'))
  try {
    const definition = await createExperimentFixtureDefinition(root)
    const definitionPath = join(root, 'definition.json'), planPath = join(root, 'plan.json')
    await writeFile(definitionPath, JSON.stringify({ ...definition, repetitions: 1 }))
    cli(['plan', '--definition', definitionPath, '--output', planPath])
    const plan = decodeExperimentPlan(JSON.parse(await readFile(planPath, 'utf8')))
    cli(['run', '--plan', planPath, '--mode', 'fixture'])
    const inspected = cli(['inspect', '--root', plan.storage.controlRoot]), first = inspected.state.units[0]
    const sessionId = plan.units[0].recipe.members[0].sessionId
    const logPath = join(plan.units[0].hostRoot, 'sessions', sessionId, 'events.log'), logBytes = await readFile(logPath)
    const evidencePath = join(plan.storage.controlRoot, first.sealed.payload.evidence.path), evidenceBytes = await readFile(evidencePath)
    const journalPath = join(plan.storage.controlRoot, 'journal-store', 'sessions', plan.journalSessionId, 'events.log'), journalBytes = await readFile(journalPath)
    const commands = [
      ['compare', '--root', plan.storage.controlRoot, '--comparison', 'a-versus-b'],
      ['evaluate', '--root', plan.storage.controlRoot, '--unit', first.unitKey],
      ['export-fixture', '--root', plan.storage.controlRoot, '--unit', first.unitKey, '--session', sessionId, '--output', join(root, 'unused.json')],
    ]
    for (const [path, bytes] of [[logPath, logBytes], [evidencePath, evidenceBytes]]) {
      await appendFile(path, Buffer.from([1]))
      for (const command of commands) cli(command, 2)
      await writeFile(path, bytes)
    }
    for (const [path, bytes] of [[evidencePath, evidenceBytes], [logPath, logBytes]]) {
      await writeFile(path, Buffer.alloc(plan.evidenceLimits.maxEvidenceBytes + 1))
      cli(['verify', '--root', plan.storage.controlRoot], 1)
      cli(['report', '--root', plan.storage.controlRoot, '--report-key', 'over-budget', '--kind', 'posthoc'], 1)
      await writeFile(path, bytes)
    }
    await unlink(join(plan.storage.controlRoot, inspected.state.reports[0].payload.report.path))
    cli(['report', '--root', plan.storage.controlRoot, '--report-key', 'primary', '--kind', 'primary'], 2)
    assert.deepEqual(await readFile(journalPath), journalBytes)
    await assert.rejects(stat(join(root, 'unused.json')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('built close releases the controller marker left by a process exit after finalization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-built-finalized-exit-'))
  try {
    const script = `
      import { createExperimentFixtureDefinition } from ${JSON.stringify(new URL('../../examples/experiment-fixture.mjs', import.meta.url).href)}
      import { planExperiment } from ${JSON.stringify(new URL('../../dist/experiment/definition.js', import.meta.url).href)}
      import { createExperimentStorage } from ${JSON.stringify(new URL('../../dist/experiment/storage.js', import.meta.url).href)}
      import { recordExperimentReport } from ${JSON.stringify(new URL('../../dist/experiment/report.js', import.meta.url).href)}
      const definition = await createExperimentFixtureDefinition(process.argv[1])
      const plan = await planExperiment({ ...definition, repetitions: 1 })
      const storage = await createExperimentStorage(plan)
      const report = await recordExperimentReport(storage, { reportKey: 'primary', kind: 'primary', finalize: true, unstartedReason: 'cancelled-before-start' })
      process.stdout.write(JSON.stringify({ root: plan.storage.controlRoot, journalSessionId: plan.journalSessionId, token: storage.lockToken, report: report.reference, cut: report.state.position }))
      process.exit(0)
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, root],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    assert.equal(child.status, 0, child.stderr)
    const info = JSON.parse(child.stdout), marker = join(info.root, '.atomic-harness.lock')
    const markerBytes = await readFile(marker), reportBytes = await readFile(join(info.root, info.report.path))
    const journal = join(info.root, 'journal-store', 'sessions', info.journalSessionId, 'events.log'), journalBytes = await readFile(journal)
    cli(['close', '--root', info.root, '--predecessor-stopped', '--expected-token', 'wrong'], 1)
    assert.deepEqual(await readFile(marker), markerBytes)
    const args = ['close', '--root', info.root, '--predecessor-stopped', '--expected-token', info.token]
    assert.equal(cli(args, 2).state.position, info.cut)
    assert.equal(cli(args, 2).state.position, info.cut)
    await assert.rejects(stat(marker), { code: 'ENOENT' })
    assert.deepEqual(await readFile(journal), journalBytes)
    assert.deepEqual(await readFile(join(info.root, info.report.path)), reportBytes)
    assert.equal(cli(['report', '--root', info.root, '--report-key', 'after-exit', '--kind', 'posthoc'], 2).finalized, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

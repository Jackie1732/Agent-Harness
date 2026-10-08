import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createExperimentFixtureDefinition } from '../examples/experiment-fixture.mjs'
import { decodeExperimentPlan } from '../dist/experiment/index.js'
import { decodeAutomationConfig, resolveAutomationConfig } from '../dist/automation/config.js'
import { isUnknownRun, openAutomationJournal } from '../dist/automation/journal.js'
import { powershellCommand, serviceCommandCards } from '../dist/tui/command-cards.js'

const bin = fileURLToPath(new URL('../dist/host/bin.js', import.meta.url))
const certificates = fileURLToPath(new URL('./host/certs/', import.meta.url))
const lockModule = new URL('../dist/host/storage-lock.js', import.meta.url).href

async function executeCard(card, directory, { expected = 0, copied = false } = {}) {
  assert.equal(card.argv[0], 'atomic-harness')
  let result
  if (copied && process.platform === 'win32') {
    const scriptPath = join(directory, "copied service ' invocation.ps1"), tracePath = join(directory, "exact argv ' trace.json")
    const quote = value => powershellCommand([value]).slice(2)
    const command = powershellCommand(card.argv)
    assert.match(command, /''/)
    await writeFile(scriptPath, [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '$OutputEncoding = [Console]::OutputEncoding',
      'function atomic-harness {',
      `  [IO.File]::WriteAllText(${quote(tracePath)}, (ConvertTo-Json -InputObject @($args) -Compress), [Text.UTF8Encoding]::new($false))`,
      `  & ${quote(process.execPath)} ${quote(bin)} @args`,
      '}', command, 'exit $LASTEXITCODE', '',
    ].join('\n'))
    result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(JSON.parse(await readFile(tracePath, 'utf8')), card.argv.slice(1))
  } else {
    result = spawnSync(process.execPath, [bin, ...card.argv.slice(1)], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    })
    assert.equal(result.error, undefined, result.error?.message)
  }
  if (expected !== null) assert.equal(result.status, expected, `${JSON.stringify(card.argv)}\n${result.stderr}\n${result.stdout}`)
  return { code: result.status, stdout: result.stdout, stderr: result.stderr,
    value: result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout) : null }
}

function experimentCard(input, command) {
  const card = serviceCommandCards(input).find(candidate => candidate.argv[1] === 'experiment' && candidate.argv[2] === command)
  assert.ok(card, `Generated experiment ${command} card`)
  return card
}

function leavePredecessorLock(root, hostKey) {
  const script = `
    import { acquireHostStorageLock } from ${JSON.stringify(lockModule)}
    const lock = await acquireHostStorageLock(process.argv[1], process.argv[2])
    process.stdout.write(JSON.stringify(lock.record))
    process.exit(0)
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, root, hostKey], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  })
  assert.equal(child.error, undefined, child.error?.message)
  assert.equal(child.status, 0, child.stderr)
  const record = JSON.parse(child.stdout)
  assert.notEqual(record.processId, process.pid)
  return record
}

test('built service cards execute all ten original Experiment commands with exact quoted paths', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "step15 service cards ' 中文 "))
  try {
    const definition = join(directory, "original definition ' source.json"), planPath = join(directory, "frozen plan ' result.json")
    await writeFile(definition, JSON.stringify(await createExperimentFixtureDefinition(directory)))
    const planned = await executeCard(experimentCard({ definition, plan: planPath }, 'plan'), directory, { copied: true })
    const plan = decodeExperimentPlan(JSON.parse(await readFile(planPath, 'utf8'))), first = plan.units[0]
    assert.equal(planned.value.planDigest, plan.planDigest)
    const input = { definition, plan: planPath, root: plan.storage.controlRoot, mode: 'fixture',
      reportKey: 'primary', unitKey: first.unitKey, evaluatorKey: 'exact-answer', comparisonKey: 'a-versus-b',
      sessionId: first.recipe.members[0].sessionId, fixtureOutput: join(directory, "exported fixture ' result.json"),
      evidenceKey: 'card-copy', evidenceFile: join(plan.storage.controlRoot, `runs/${first.unitKey}/evidence.json`),
      sourceFile: join(directory, "reviewed evidence ' source.json"), expectedToken: 'allocated-below' }
    assert.deepEqual(new Set(serviceCommandCards(input).map(card => card.argv[2])), new Set([
      'plan', 'run', 'inspect', 'verify', 'report', 'evaluate', 'compare', 'export-fixture', 'close', 'register-evidence',
    ]))
    assert.equal((await executeCard(experimentCard(input, 'run'), directory)).value.finalized, true)
    const inspected = (await executeCard(experimentCard(input, 'inspect'), directory, { copied: true })).value
    assert.equal(inspected.kind, 'initialized')
    const journalPath = join(plan.storage.controlRoot, 'journal-store', 'sessions', plan.journalSessionId, 'events.log')
    const journalBytes = await readFile(journalPath)
    assert.equal((await executeCard(experimentCard(input, 'verify'), directory)).value.complete, true)
    const comparison = (await executeCard(experimentCard(input, 'compare'), directory, { copied: true })).value
    assert.equal(comparison.status, 'primary-fixed')
    assert.equal(comparison.summary.a.qualityCounts.pass, 2)
    assert.equal(comparison.summary.b.qualityCounts.fail, 2)
    assert.deepEqual(await readFile(journalPath), journalBytes)
    const primaryPath = join(plan.storage.controlRoot, inspected.state.reports[0].payload.report.path), primaryBytes = await readFile(primaryPath)
    assert.equal((await executeCard(experimentCard(input, 'evaluate'), directory)).value.overall, 'pass')
    assert.equal((await executeCard(experimentCard(input, 'report'), directory, { copied: true })).value.finalized, true)
    assert.equal((await executeCard(experimentCard(input, 'export-fixture'), directory, { copied: true })).value.status, 'supported')
    const exported = JSON.parse(await readFile(input.fixtureOutput, 'utf8'))
    assert.equal(exported.format, 'normalized-call-fixture/v1')
    assert.equal(exported.entries.length, 1)
    assert.match(JSON.stringify(exported.entries[0].request), /The answer is 42\./)
    const originalUnit = inspected.state.units.find(unit => unit.unitKey === first.unitKey)
    await writeFile(input.sourceFile, JSON.stringify({ kind: 'reviewed-copy/v1', actionKey: 'card-copy',
      originalDisposition: { address: plan.experimentId, eventId: originalUnit.sealed.stored.eventId },
      originalEvidence: originalUnit.sealed.payload.evidence, recipeDigest: originalUnit.started.payload.recipeDigest, sourceRoot: first.hostRoot }))
    assert.equal((await executeCard(experimentCard(input, 'register-evidence'), directory)).value.payload.evidenceKey, 'card-copy')
    const predecessor = leavePredecessorLock(plan.storage.controlRoot, 'experiment-card-controller')
    input.expectedToken = predecessor.token
    const markerPath = join(plan.storage.controlRoot, '.atomic-harness.lock')
    assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).token, predecessor.token)
    assert.equal((await executeCard(experimentCard(input, 'close'), directory, { copied: true })).value.state.finalized.payload.reportKey, 'primary')
    await assert.rejects(stat(markerPath), { code: 'ENOENT' })
    assert.deepEqual(await readFile(primaryPath), primaryBytes)
    t.diagnostic(`Executed 10 generated Experiment argv; ${process.platform === 'win32' ? '6 copied PowerShell commands also preserved every argument' : 'PowerShell execution not-run on this non-Windows host'}`)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('built Automation cards preserve unknown run and require the exact stopped predecessor token', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "step15 automation cards ' 中文 "))
  let store
  try {
    const path = join(directory, "automation deployment ' config.json")
    const raw = JSON.parse(await readFile(new URL('../examples/automation-config.json', import.meta.url), 'utf8'))
    raw.journal.root = join(directory, "durable automation ' journal")
    raw.client.origin = 'https://127.0.0.1:1'
    raw.client.tls = { caFile: join(certificates, 'ca.pem'), certFile: join(certificates, 'client.pem'), keyFile: join(certificates, 'client-key.pem') }
    raw.webhook.listenPort = 0
    raw.webhook.tls = { certFile: join(certificates, 'server.pem'), keyFile: join(certificates, 'server-key.pem') }
    raw.jobs = [{ jobKey: 'review', agentKey: 'writer', trigger: { kind: 'webhook' } }]
    await writeFile(path, JSON.stringify(raw))
    const config = resolveAutomationConfig(decodeAutomationConfig(raw), directory)
    store = await openAutomationJournal(config)
    const trigger = (await store.journal.accept('review', 'card-trigger', 'explicit fixture task', 0, config.limits.maxQueued)).trigger
    await store.journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey })
    await store.journal.append({ kind: 'submitted', triggerKey: trigger.triggerKey, inputEventId: trigger.acceptedEventId })
    const runIntent = await store.journal.append({ kind: 'run-intent', triggerKey: trigger.triggerKey })
    await store.dispose(); store = undefined
    const predecessor = leavePredecessorLock(config.journal.root, `automation:${config.automationKey}`)
    const markerPath = join(config.journal.root, '.atomic-harness.lock'), markerBytes = await readFile(markerPath)
    const journalPath = join(config.journal.root, 'sessions', config.journal.sessionId, 'events.log'), journalBytes = await readFile(journalPath)
    const cards = serviceCommandCards({ automation: path, triggerKey: trigger.triggerKey, expectedToken: predecessor.token })
    const acknowledge = cards.find(card => card.argv.includes('--acknowledge-run-unknown'))
    const unlock = cards.find(card => card.argv.includes('--unlock'))
    assert.deepEqual(unlock.argv.slice(-4), ['--unlock', '--predecessor-stopped', '--expected-token', predecessor.token])
    assert.notEqual((await executeCard(acknowledge, directory, { expected: null })).code, 0)
    const wrong = serviceCommandCards({ automation: path, expectedToken: 'wrong-predecessor-token' }).find(card => card.argv.includes('--unlock'))
    assert.notEqual((await executeCard(wrong, directory, { expected: null })).code, 0)
    assert.deepEqual(await readFile(markerPath), markerBytes)
    assert.deepEqual(await readFile(journalPath), journalBytes)
    assert.equal((await executeCard(unlock, directory, { copied: true })).value.kind, 'automation-unlocked')
    await assert.rejects(stat(markerPath), { code: 'ENOENT' })
    assert.deepEqual(await readFile(journalPath), journalBytes)
    const acknowledged = (await executeCard(acknowledge, directory, { copied: true })).value
    assert.equal(acknowledged.kind, 'automation-run-unknown-acknowledged')
    assert.equal(acknowledged.runAcceptance, 'unknown')
    store = await openAutomationJournal(config)
    const current = store.journal.get(trigger.triggerKey)
    assert.equal(current.runIntent, runIntent)
    assert.equal(current.inputEventId, trigger.acceptedEventId)
    assert.equal(current.runReturned, false)
    assert.equal(current.runUnknownAcknowledged, true)
    assert.equal(isUnknownRun(current), true)
    assert.deepEqual(store.journal.blockedRuns, [])
    assert.equal(store.journal.triggers.length, 1)
    t.diagnostic(`Executed generated unknown/unlock argv; ${process.platform === 'win32' ? '2 copied PowerShell commands preserved every argument' : 'PowerShell execution not-run on this non-Windows host'}; no Automation service started`)
  } finally { await store?.dispose(); await rm(directory, { recursive: true, force: true }) }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildOperatorProfile } from '../dist/operator/profile.js'
import { builtUiFixture } from './ui-built-fixture.mjs'
import { operatorCli, verifyLocalOperatorCli } from './pack/operator-consumer.mjs'
import { verifyTerminalConsumer } from './pack/terminal-consumer.mjs'

const library = fileURLToPath(new URL('../', import.meta.url)), certRoot = fileURLToPath(new URL('./host/certs/', import.meta.url))

test('separate packaged CLI processes setup, plan, initialize, submit-only and run on a new instance', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-built-local-'))
  try { await verifyLocalOperatorCli(library, directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
})

test('remote mTLS CLI attach closes only its client until explicit host stop', { timeout: 90000 }, async () => {
  const fixture = await builtUiFixture(), path = join(fixture.directory, 'operator.json')
  const profile = buildOperatorProfile({ kind: 'remote', origin: fixture.config.remote.origin, serverName: 'localhost',
    tlsFiles: { ca: join(certRoot, 'ca.pem'), cert: join(certRoot, 'client.pem'), key: join(certRoot, 'client-key.pem') },
    limits: fixture.config.remote.limits, targets: { agentKeys: ['writer', 'reviewer'], workflowKeys: [] } })
  await writeFile(path, JSON.stringify(profile))
  const command = args => operatorCli(library, fixture.directory, [...args, '--profile', path])
  try {
    const accepted = await command(['task', 'submit', '--agent', 'writer', '--key', 'remote-built', '--text', '远端保持在线'])
    assert.equal(accepted.acceptance, 'accepted'); assert.equal(accepted.closing.status, 'not-owned')
    assert.equal(fixture.service.status, 'ready')
    const attached = await command(['status'])
    assert.equal(attached.scope.instanceId, fixture.service.ready.instanceId); assert.equal(attached.result.hostStatus, 'ready')
    assert.equal((await command(['task', 'get', '--agent', 'writer', '--key', 'remote-built'])).result.status, 'queued')
    assert.equal((await command(['run-once'])).result.report.businessRuns, 1)
    assert.equal((await command(['task', 'get', '--agent', 'writer', '--key', 'remote-built'])).result.status, 'handled')
    assert.equal((await command(['status'])).result.hostStatus, 'ready')
    assert.equal((await command(['host', 'stop', '--mode', 'drain'])).result.hostStatus, 'stopped')
    await fixture.service.closed
    assert.equal(fixture.service.status, 'closed')
  } finally { await fixture.dispose() }
})

test('plain Node loads installed terminal resources and releases the Ink instance', async () => {
  assert.equal((await verifyTerminalConsumer(library)).rendererReleased, true)
})

test('core, client, protocol, help and version never load terminal renderers', { timeout: 30000 }, async () => {
  const preload = fileURLToPath(new URL('./pack/inert-preload.mjs', import.meta.url))
  const launch = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, ...args], { cwd: library, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { errors += chunk })
    child.once('error', reject); child.once('close', code => { try { assert.equal(code, 0, `${errors}\n${output}`); resolve(output) } catch (error) { reject(error) } })
  })
  await launch(['--input-type=module', '--eval', "await import('@atomic-harness/core'); await import('@atomic-harness/core/client'); await import('@atomic-harness/core/protocol')"])
  assert.match(await launch([join(library, 'dist', 'host', 'bin.js'), '--help']), /Human commands/)
  assert.match(await launch([join(library, 'dist', 'host', 'bin.js'), '--version']), /0\.1\./)
})

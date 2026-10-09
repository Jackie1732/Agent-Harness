import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Run the shipped CLI in a separate plain Node process and retain its complete output. */
export function operatorCli(library, directory, args, { input = '', exitCode = 0, json = true, node = process.execPath } = {}) {
  const child = spawn(node, [join(library, 'dist', 'host', 'bin.js'), ...args, ...(json ? ['--json'] : [])],
    { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.on('error', () => { /* A rejected command can close stdin before consuming its finite fixture. */ })
  child.stdin.end(input)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Operator CLI deadline: ${args.join(' ')}`)) }, 30000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      try {
        assert.equal(signal, null, stderr)
        assert.equal(code, exitCode, `${stderr}\n${stdout}`)
        resolve(json ? JSON.parse(stdout) : stdout)
      } catch (error) { reject(error) }
    })
  })
}

/** Empty-directory setup and each subsequent action use the consumer's installed CLI. */
export async function verifyLocalOperatorCli(library, directory, node = process.execPath) {
  assert.deepEqual(await readdir(directory), [])
  const { buildOperatorProfile } = await import(pathToFileURL(join(library, 'dist', 'operator', 'profile.js')))
  const { buildHostPreset } = await import(pathToFileURL(join(library, 'dist', 'operator', 'config-presets.js')))
  const profilePath = join(directory, 'operator.json')
  const profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'drain' })
  const host = buildHostPreset('solo-scripted', { hostKey: 'packaged-operator', storageRoot: join(directory, 'store'), text: '科研笔记完成 👩‍💻' }, directory)
  const command = (args, options = {}) => operatorCli(library, directory, [...args, '--profile', profilePath], { node, ...options })
  const setup = await command(['setup', '--mode', 'local', '--params-stdin', '--yes'], { input: JSON.stringify({ profile, host }) })
  assert.equal(setup.status, 'ok')
  assert.equal((await command(['config', 'check', '--kind', 'host'], { exitCode: 10 })).status, 'pending')
  assert.equal((await command(['config', 'plan', '--kind', 'host', '--yes'])).status, 'ok')
  const planned = JSON.parse(await readFile(join(directory, 'host.json'), 'utf8'))
  assert.equal(planned.schemaVersion, 3); assert.ok(planned.members[0].sessionId)
  assert.equal(JSON.parse(await command(['init'], { json: false })).protocolVersion, 3)
  const key = 'k'.repeat(64)
  const accepted = await command(['task', 'submit', '--agent', 'writer', '--key', key, '--text-stdin'], { input: '学习\n完整科研任务 é' })
  assert.equal(accepted.acceptance, 'accepted'); assert.equal(accepted.closing.status, 'released')
  assert.equal(accepted.scope.connectionLifetime, 'command')
  assert.equal(accepted.result.sessionId, planned.members[0].sessionId)
  const queued = await command(['task', 'get', '--agent', 'writer', '--key', key])
  assert.equal(queued.result.status, 'queued'); assert.equal(queued.result.rootId, null)
  const run = await command(['run-once'])
  assert.equal(run.acceptance, 'accepted'); assert.equal(run.result.report.businessRuns, 1)
  assert.notEqual(run.scope.instanceId, accepted.scope.instanceId)
  const handled = await command(['task', 'get', '--agent', 'writer', '--key', key])
  assert.equal(handled.result.status, 'handled'); assert.equal(handled.result.inputEventId, accepted.result.inputEventId)
  const completed = await command(['root', 'get', '--params-stdin'], { input: JSON.stringify({ agentKey: 'writer', rootId: handled.result.rootId }) })
  assert.equal(completed.result.outcome, 'completed'); assert.equal(completed.result.final.text, '科研笔记完成 👩‍💻')
  const intents = await command(['journal', 'inspect'])
  assert.deepEqual(intents.result.filter(fact => fact.kind === 'prepared').map(fact => fact.intent.method), ['input.submit', 'host.run'])
  await writeFile(profilePath, JSON.stringify({ ...profile, output: { ...profile.output, maxBytes: 2048 },
    observation: { ...profile.observation, maxPageBytes: 4096 } }))
  const events = ['events', '--params-stdin'], eventQuery = { target: { kind: 'member', agentKey: 'writer' },
    after: Number(accepted.result.inputEventId.split(':').at(-1)) - 1, maxEvents: profile.observation.maxPageEvents }
  for (const json of [true, false]) {
    const output = await command(events, { input: JSON.stringify(eventQuery), json })
    const page = json ? output : JSON.parse(output)
    assert.ok(Buffer.byteLength(json ? JSON.stringify(output) + '\n' : output) <= 2048)
    assert.equal(page.result.events[0].eventId, accepted.result.inputEventId)
    assert.equal(page.result.nextCursor.nextSequence, page.result.events.at(-1).sequence + 1)
    assert.equal(page.closing.status, 'released')
  }
  return { schemaVersion: 3, separateCliProcesses: 12, submitOnly: true, reopenedInstance: true, boundedEventEncodings: ['json', 'plain'],
    inputEventId: accepted.result.inputEventId, final: completed.result.final.text }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyLocalOperatorCli(process.argv[2], process.argv[3])))
}

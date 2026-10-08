import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { publishConfigFile, readConfigFile } from '../dist/operator/config-files.js'

const limits = { maxBytes: 65536, maxDepth: 16, maxNodes: 10000 }
const moduleUrl = new URL('../dist/operator/config-files.js', import.meta.url).href
function child(path, revision, hold) {
  const code = `import { publishConfigFile } from ${JSON.stringify(moduleUrl)};
    const released = new Promise(resolve => process.once('message', resolve));
    try {
      await publishConfigFile(process.env.CONFIG_PATH, { value: 2 }, { replace: true, expectedRevision: process.env.CONFIG_REVISION },
        ${JSON.stringify(limits)}, ${hold ? "async () => { process.send('ready'); await released }" : 'undefined'});
      process.send('saved');
    } catch (error) { process.send(error.code); }
    process.disconnect();`
  const processChild = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    env: { ...process.env, CONFIG_PATH: path, CONFIG_REVISION: revision }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stderr = ''
  processChild.stderr.on('data', bytes => { stderr += bytes })
  const messages = [], pending = []
  processChild.on('message', value => { if (pending.length) pending.shift()(value); else messages.push(value) })
  const exited = new Promise(resolve => processChild.once('exit', (code, signal) => resolve({ code, signal, stderr })))
  return { processChild, exited, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => pending.push(resolve)) }
}

test('separate editors cannot publish under the same file lease', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-config-process-')), path = join(root, 'config.json'), children = []
  try {
    const revision = await publishConfigFile(path, { value: 1 }, {}, limits)
    const first = child(path, revision, true); children.push(first)
    assert.equal(await first.next(), 'ready')
    const second = child(path, revision, false); children.push(second)
    assert.equal(await second.next(), 'HOST_LOCKED')
    const secondExit = await second.exited
    assert.equal(secondExit.signal, null, secondExit.stderr)
    assert.equal(secondExit.code, 0, secondExit.stderr)
    first.processChild.send('release')
    assert.equal(await first.next(), 'saved')
    const firstExit = await first.exited
    assert.equal(firstExit.signal, null, firstExit.stderr)
    assert.equal(firstExit.code, 0, firstExit.stderr)
    assert.deepEqual((await readConfigFile(path, limits)).value, { value: 2 })
    assert.deepEqual(await readdir(root), ['config.json'])
  } finally {
    for (const value of children) { if (value.processChild.exitCode === null) value.processChild.kill(); await value.exited }
    await rm(root, { recursive: true, force: true })
  }
})

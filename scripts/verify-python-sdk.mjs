import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, appendFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const python = process.env.ATOMIC_HARNESS_PYTHON
if (python === undefined) throw new Error('Set ATOMIC_HARNESS_PYTHON to a Python >=3.11 environment with jsonschema, mypy, types-jsonschema and ruff')
const env = { ...process.env, PYTHONUTF8: '1', PYTHONPATH: resolve('python/src') }
const logfile = resolve('.tmp/python-sdk-validation.log'), records = []
await mkdir('.tmp', { recursive: true }); await writeFile(logfile, '')
async function run(command, args, expected = 0) {
  const started = new Date().toISOString()
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += String(chunk) })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  const record = { command, args, started, ended: new Date().toISOString(), code }
  records.push(record); await appendFile(logfile, JSON.stringify(record) + '\n' + output + '\n')
  assert.equal(code, expected, output)
  return output
}
await run(process.execPath, ['scripts/generate-python-protocol.mjs', '--check'])
await run(python, ['-m', 'ruff', 'check', 'python'])
await run(python, ['-m', 'mypy', '--strict', 'python/src/atomic_harness', 'python/tests/typecheck_positive.py'])
await run(python, ['-m', 'mypy', '--strict', 'python/src/atomic_harness/client.py'])
const negative = await run(python, ['-m', 'mypy', '--strict', '--no-error-summary', 'python/tests/typecheck_negative.py'], 1)
assert.equal((negative.match(/: error:/g) ?? []).length, 4, negative)
await run(python, ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_*.py', '-v'])
const pnpm = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'pnpm'
const args = process.platform === 'win32' ? ['/d', '/c', 'pnpm exec vitest run tests/python-protocol.spec.ts'] : ['exec', 'vitest', 'run', 'tests/python-protocol.spec.ts']
await run(pnpm, args)
await run(process.execPath, ['--test', 'tests/python-control.built.node.mjs'])
await writeFile(resolve('.tmp/python-sdk-validation.exit.json'), JSON.stringify({ passed: true, records }, null, 2) + '\n')
console.log(JSON.stringify({ kind: 'python-sdk-validation', passed: true, gates: records.length, log: logfile }))

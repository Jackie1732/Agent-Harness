import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

for (const mode of ['complete', 'cancel']) test(`built-in HTTPS peers join both concurrent roots on ${mode}`, { timeout: 120000 }, async context => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/workflow-parallel-child.mjs', import.meta.url)), mode], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('./host/certs/ca.pem', import.meta.url)) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: context.signal,
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  assert.equal(code, 0, output)
  assert.match(output, /parallel HTTPS roots verified/)
})

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { runHostCli } from '../../src/index.js'
import { subagentHostConfig } from './subagent-fixture.js'

function streams(input = '') {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough()
  let output = ''; stdout.on('data', chunk => { output += chunk.toString() }); stdin.end(input)
  return { stdin, stdout, stderr, records: () => output.trim().split('\n').map(line => JSON.parse(line)) }
}
it.each([1, 2] as const)('uses protocol %s consistently for ready, errors, command responses and completion', async version => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-cli2-'))
  try {
    const path = join(root, 'host.json')
    await writeFile(path, JSON.stringify(await subagentHostConfig(join(root, 'storage'))))
    const selected = ['--config', path, '--protocol-version', String(version)]
    await runHostCli(['init', ...selected], streams())
    const command = { protocolVersion: version, requestId: 'report', kind: 'report' }
    const io = streams('invalid\n' + JSON.stringify(command) + '\n' + JSON.stringify(command) + '\n'
      + JSON.stringify({ ...command, requestId: 'mismatch', protocolVersion: version === 1 ? 2 : 1 }))
    expect(await runHostCli(['run', ...selected], io)).toBe(2)
    const records = io.records()
    expect(records.every(record => record.protocolVersion === version)).toBe(true)
    expect(records.filter(record => record.kind === 'error')).toHaveLength(3)
    const report = records.find(record => record.kind === 'report').report
    expect(Object.hasOwn(report, 'subagents')).toBe(version === 2)
    expect(Object.hasOwn(records.at(-1).report, 'subagents')).toBe(version === 2)
    expect(io.stdout.destroyed).toBe(false)
    const inspect = streams(); await runHostCli(['inspect', ...selected], inspect)
    expect(Object.hasOwn(inspect.records()[0], 'subagents')).toBe(version === 2)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 20000)

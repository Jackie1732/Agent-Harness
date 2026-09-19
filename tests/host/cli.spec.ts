import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { boundedJsonLines, runHostCli } from '../../src/index.js'
import { hostConfig } from './fixtures.js'

function streams(input = '') {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdin.end(input)
  return { stdin, stdout, stderr, output: () => output }
}

describe('Host CLI', () => {
  it('initializes and runs through the same Host API using bounded JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-host-cli-'))
    const path = join(root, 'host.json')
    await writeFile(path, JSON.stringify(hostConfig(join(root, 'sessions'))), 'utf8')
    const init = streams()
    expect(await runHostCli(['init', '--config', path], init)).toBe(0)
    expect(JSON.parse(init.output())).toMatchObject({ kind: 'initialized' })

    const run = streams(`${JSON.stringify({ protocolVersion: 1, requestId: 'task-1', kind: 'task', agentKey: 'writer', text: '中文 task' })}\n`)
    expect(await runHostCli(['run', '--config', path], run)).toBe(0)
    const records = run.output().trim().split('\n').map(line => JSON.parse(line))
    expect(records[0]).toMatchObject({ kind: 'ready', mode: 'run' })
    expect(records[1]).toMatchObject({ protocolVersion: 1, requestId: 'task-1', kind: 'accepted', command: 'task', agentKey: 'writer' })
    expect(records.at(-1)).toMatchObject({ kind: 'complete' })
    expect(JSON.stringify(records.at(-1))).toContain('fixed answer')
  })

  it('decodes a split multibyte final line and rejects an oversized unterminated line', async () => {
    const split = new PassThrough()
    const values: unknown[] = []
    const reading = (async () => { for await (const value of boundedJsonLines(split, 64)) values.push(value) })()
    const bytes = Buffer.from('{"text":"中文"}')
    split.write(bytes.subarray(0, 11)); split.end(bytes.subarray(11))
    await reading
    expect(values).toEqual([{ text: '中文' }])

    const oversized = new PassThrough()
    const failed = (async () => { for await (const _value of boundedJsonLines(oversized, 4)) { /* consume */ } })()
    oversized.end('12345')
    await expect(failed).rejects.toMatchObject({ code: 'HOST_PROTOCOL_INVALID' })
  })

  it('plans null identities before complete configuration resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-host-plan-'))
    const path = join(root, 'host.json')
    const config = hostConfig(join(root, 'sessions'))
    const member = (config.members as readonly Record<string, unknown>[])[0]!
    await writeFile(path, JSON.stringify({ ...config, members: [{ ...member, sessionId: null }] }), 'utf8')
    const io = streams()
    expect(await runHostCli(['plan', '--config', path], io)).toBe(0)
    const planned = JSON.parse(io.output()) as { members: readonly { sessionId: string }[] }
    expect(planned.members[0]!.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

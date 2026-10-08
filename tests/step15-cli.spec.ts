import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { runOperatorCli } from '../src/operator/cli.js'
import { runProfileMaintenance } from '../src/operator/maintenance.js'
import { parseOperatorArguments } from '../src/operator/cli-arguments.js'
import { operatorJson } from '../src/operator/cli-output.js'
import { buildOperatorProfile } from '../src/operator/profile.js'
import { buildHostPreset } from '../src/operator/config-presets.js'
import { operatorExitCode } from '../src/operator/result.js'
import { twoMemberHostConfig } from './host/fixtures.js'
import { initializeHost } from '../src/host/initialization.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import type { OperatorResult } from '../src/operator/types.js'
import type { JsonObject } from '../src/foundation/json.js'

function output(input = '') {
  let text = '', errors = ''
  const io = { stdin: Readable.from([input]), stdout: new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback() } }),
    stderr: new Writable({ write(chunk, _encoding, callback) { errors += chunk.toString(); callback() } }) }
  return { io, text: () => text, errors: () => errors }
}
async function execute(path: string, args: string[], input = '') {
  const stream = output(input), code = await runOperatorCli([...args, '--profile', path, '--json'], stream.io, {})
  return { code, result: JSON.parse(stream.text()) as OperatorResult, errors: stream.errors() }
}

it('rejects ambiguous grammar and confirmation before allocating identities or opening resources', async () => {
  const invalid = [
    ['task', 'submit', '--agent', 'writer', '--text', 'a', '--text-stdin'],
    ['task', 'get', '--agent', 'writer', '--key', 'a', '--input-event', 'b'],
    ['task', 'submit', '--agent', 'writer', '--text', 'a', '--acknowledge-intent', 'b'],
    ['config', 'check', '--all', '--kind', 'host'], ['config', 'export', '--kind', 'host', '--json'],
    ['events', '--params-stdin', '--text-stdin'], ['status', '--unknown', 'a'], ['status', '--profile', 'other'],
    ['config', 'apply', '--kind', 'host'], ['tui', '--json'],
  ]
  for (const args of invalid) {
    if (args[0] === 'tui') continue
    expect(() => parseOperatorArguments([...args, '--profile', 'missing.json'])).toThrow()
  }
  const directory = await mkdtemp(join(tmpdir(), 'step15-cli-grammar-')), path = join(directory, 'operator.json')
  try {
    expect((await execute(path, ['setup', '--mode', 'local', '--params-stdin'], '{}')).code).toBe(2)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await execute(path, ['tui'])).code).toBe(2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('supports an empty-directory v3 setup, plan, explicit init, submit-only and new-instance finite run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-cli-empty-')), path = join(directory, 'operator.json')
  try {
    const profile = buildOperatorProfile({ kind: 'local', hostConfig: 'host.json', shutdownMode: 'drain' })
    let schema: JsonObject = { type: 'string' }
    for (let depth = 0; depth < 16; depth++) schema = { type: 'object', properties: { nested: schema }, required: ['nested'], additionalProperties: false }
    const host = { ...buildHostPreset('solo-scripted', { hostKey: 'my-host', storageRoot: join(directory, 'store'), text: '学术结论' }) as JsonObject,
      messages: [{ type: 'research/nested', payloadVersion: 1, schema }] }
    expect((await execute(path, ['setup', '--mode', 'local', '--params-stdin', '--yes'], JSON.stringify({ profile, host }))).code).toBe(0)
    expect((await execute(path, ['config', 'check', '--kind', 'host'])).code).toBe(10)
    const allBeforePlan = await execute(path, ['config', 'check', '--all'])
    expect(allBeforePlan).toMatchObject({ code: 10, result: { status: 'pending', closing: { status: 'not-owned' } } })
    expect((await execute(path, ['config', 'plan', '--kind', 'host', '--yes'])).code).toBe(0)
    const initialized = output()
    expect(await runProfileMaintenance(['init', '--profile', path], initialized.io)).toBe(0)
    expect(JSON.parse(initialized.text()).protocolVersion).toBe(3)
    expect((await execute(path, ['config', 'check', '--all'])).code).toBe(0)
    const submitted = await execute(path, ['task', 'submit', '--agent', 'writer', '--text-stdin', '--key', 'research'], '学习\n第二行\u009b控制字符')
    expect(submitted.code, JSON.stringify(submitted.result)).toBe(0)
    expect(submitted.result).toMatchObject({ command: 'task.submit', acceptance: 'accepted', closing: { status: 'released' }, scope: { connectionLifetime: 'command' } })
    const input = await execute(path, ['task', 'get', '--agent', 'writer', '--key', 'research'])
    expect(input.result).toMatchObject({ acceptance: 'not-applicable', result: { status: 'queued', rootId: null } })
    const run = await execute(path, ['run-once'])
    expect(run.code).toBe(0)
    expect(run.result.scope.instanceId).not.toBe(submitted.result.scope.instanceId)
    expect(run.result.scope.hostKey).toBe('my-host')
    const finished = await execute(path, ['task', 'get', '--agent', 'writer', '--key', 'research'])
    expect(finished.result).toMatchObject({ result: { status: 'handled', sessionId: (submitted.result.result as { sessionId: string }).sessionId } })
    const stdoutExport = output()
    expect(await runOperatorCli(['config', 'export', '--kind', 'host', '--profile', path], stdoutExport.io, {})).toBe(0)
    expect(JSON.parse(stdoutExport.text()).schemaVersion).toBe(3)
    expect(stdoutExport.text()).not.toContain('operatorVersion')
    const operatorBefore = await readFile(path)
    expect((await execute(path, ['config', 'set', '--kind', 'operator', '--pointer', '/display/maxTextBytes', '--value-stdin'], '123')).code).toBe(2)
    expect(await readFile(path)).toEqual(operatorBefore)
    await writeFile(join(directory, 'host.json'), '{}')
    const invalidCheck = await execute(path, ['config', 'check', '--all'])
    expect(invalidCheck).toMatchObject({ code: 2, result: { status: 'rejected', closing: { status: 'not-owned' }, error: { domainCode: 'HOST_CONFIG_INVALID' } } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects local instance-only commands before even reading the Host file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-cli-instance-')), path = join(directory, 'operator.json')
  const profile = buildOperatorProfile({ kind: 'local', hostConfig: 'nonexistent-host.json', shutdownMode: 'drain' })
  await writeFile(path, JSON.stringify(profile))
  try {
    for (const args of [['agent', 'pause', '--agent', 'writer'], ['agent', 'resume', '--agent', 'writer'], ['host', 'stop', '--mode', 'drain']]) {
      const result = await execute(path, args)
      expect(result).toMatchObject({ code: 2, result: { operationId: null, closing: { status: 'not-owned' }, error: { code: 'OPERATOR_LOCAL_INSTANCE_COMMAND' } } })
    }
    await expect(stat(join(directory, profile.journal.root))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('drives and observes actual two-session message delivery through the same CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-cli-message-')), path = join(directory, 'operator.json')
  const hostPath = join(directory, 'host.json'), host = twoMemberHostConfig(join(directory, 'store'))
  await writeFile(path, JSON.stringify(buildOperatorProfile({ kind: 'local', hostConfig: hostPath, shutdownMode: 'drain' })))
  await writeFile(hostPath, JSON.stringify(host)); await initializeHost(resolveHostConfig(decodeHostConfig(host, directory)))
  try {
    const sent = await execute(path, ['message', 'send', '--params-stdin'], JSON.stringify({ agentKey: 'writer', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: JSON.stringify({ text: '请审阅' }) }))
    expect(sent.result).toMatchObject({ acceptance: 'accepted', result: { status: 'outbox-accepted' } })
    expect((await execute(path, ['run-once'])).code).toBe(0)
    const messageId = (sent.result.result as { messageId: string }).messageId
    const observed = await execute(path, ['message', 'get', '--params-stdin'], JSON.stringify({ agentKey: 'writer', direction: 'outbox', messageId }))
    expect(observed.result).toMatchObject({ acceptance: 'not-applicable', result: { fact: { status: 'delivered' } } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('escapes executable terminal bytes in JSON without changing the decoded value', () => {
  const data = { text: '\u001b]8;;https://example.com\u0007链接\u001b]8;;\u0007\u009b31m\u009dtitle\u0000' }
  const encoded = operatorJson(data)
  expect(encoded).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  expect(JSON.parse(encoded)).toEqual(data)
})

it('keeps composite input acceptance and applies original Host run exit codes', () => {
  const result = { command: 'task.submit', acceptance: 'accepted', status: 'ok', error: null, closing: { status: 'released' }, result: {
    input: { acceptance: 'accepted' }, run: { acceptance: 'accepted', result: { report: { stoppedBy: 'batch-budget', counts: {
      pendingInputs: 1, runnableInputs: 1, pendingWaits: 0, failedRoots: 0, exhaustedRoots: 0, reviewRequiredInputs: 0, unsupportedInputs: 0, blockedMembers: 0,
      pendingOutbox: 0, pendingMaintenance: 0 }, blockedRoutes: [], members: [] } } } } } as unknown as OperatorResult
  expect(operatorExitCode(result)).toBe(12)
  expect(operatorExitCode({ ...result, acceptance: 'unknown', closing: { status: 'failed', mode: 'cancel' } })).toBe(4)
})

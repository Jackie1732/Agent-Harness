import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Box, render } from 'ink'
import type { Instance } from 'ink'
import { expect, it } from 'vitest'
import { runTui } from '../src/tui/lifecycle.js'
import { ConfigurationPage } from '../src/tui/configuration.js'
import { runSetupWizard } from '../src/tui/wizards.js'
import { buildOperatorProfile, readOperatorProfile } from '../src/operator/profile.js'
import { openOperatorSession } from '../src/operator/session.js'
import type { OperatorSession } from '../src/operator/types.js'
import { initializeHost } from '../src/host/initialization.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import type { HostStatusResult } from '../src/protocol/index.js'
import { hostConfig, hostSessionId } from './host/fixtures.js'
import { deferred, sendTui, tuiStreams } from './step15-tui-streams.js'

async function fixture(filledJournal = false) {
  const directory = await mkdtemp(join(tmpdir(), 'step15-tui-feedback-')), profilePath = join(directory, 'operator.json')
  const config = hostConfig(join(directory, 'store'))
  await initializeHost(resolveHostConfig(decodeHostConfig(config, directory)))
  await writeFile(join(directory, 'host.json'), JSON.stringify(config))
  const profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'drain' })
  await writeFile(profilePath, JSON.stringify({ ...profile, journal: filledJournal ? { ...profile.journal, maxIntents: 1, maxEvents: 3 } : profile.journal,
    observation: { ...profile.observation, pollIntervalMs: 25 } }))
  return { directory, profilePath }
}

async function desk(filledJournal = false) {
  const f = await fixture(filledJournal), io = tuiStreams(), signals = new EventEmitter()
  const rendered = deferred<Instance>(), opened = deferred<OperatorSession>()
  const running = runTui(f.profilePath, io, {}, { signals, render: (node, options) => {
    const instance = render(node, { ...options, interactive: true }); rendered.resolve(instance); return instance
  }, openSession: async (path, options) => {
    const session = await openOperatorSession(path, options)
    if (filledJournal) expect(await session.submit({ agentKey: 'writer', submissionKey: 'fills-journal', text: '保留的事件' })).toMatchObject({ acceptance: 'accepted' })
    opened.resolve(session); return session
  } })
  const instance = await rendered.promise, session = await opened.promise
  await expect.poll(() => io.stdout.frames).toContain('test-host')
  await instance.waitUntilRenderFlush()
  return { ...f, io, session, send: (data: string) => sendTui(io.stdin, instance, data), dispose: async () => {
    signals.emit('SIGTERM'); await running; io.destroy(); await rm(f.directory, { recursive: true, force: true })
  } }
}

it('shows a protocol error inside the retained request preview and accepts its typed correction', async () => {
  const f = await desk()
  try {
    const instanceId = ((await f.session.execute('host.status', {})).result as HostStatusResult).instanceId
    for (const data of ['s', '\u001b[B', 'd', '\u0013', '\r']) await f.send(data)
    await expect.poll(() => f.io.stdout.frames).toContain('参数未通过原协议校验')
    expect(f.io.stdout.frames).toContain('Esc 继续编辑')
    expect(f.session.intents()).toEqual([])
    f.io.stdout.frames = ''; await f.send('\u001b')
    await expect.poll(() => f.io.stdout.frames).toContain('i 新增')
    for (const data of ['\u001b[A', 'i', 'expectedInstanceId', '\r', '\r', '\u001b[B', '\u001b[B', '\r', instanceId, '\r', '\u0013', '\r']) await f.send(data)
    await expect.poll(() => f.io.stdout.frames).toContain('确认精确 host.shutdown 目标')
    expect(f.session.intents()).toEqual([])
  } finally { await f.dispose() }
})

it('shows a checkpoint failure and stale event facts after a real displayed page fills the journal', async () => {
  const f = await desk(true)
  try {
    for (const data of ['e', '\u001b[B', '\r', '\u0013']) await f.send(data)
    f.io.stdout.frames = ''; await f.send('\r')
    await expect.poll(() => f.io.stdout.frames).toContain('读取或 checkpoint 失败；保留旧页面')
    expect(f.io.stdout.frames).toContain('read-failure')
    expect(f.io.stdout.frames).toContain('STALE · 保留上次核验事实')
    expect(f.io.stdout.frames).toContain(hostSessionId)
    expect(f.io.stdout.frames).toContain('已消费 1 页/')
    expect(f.session.eventCheckpoint(hostSessionId)).toBeUndefined()
    expect(f.session.intents()).toHaveLength(1)
  } finally { await f.dispose() }
})

it('renders the actual single event page selected from the events screen without advancing a follow checkpoint', async () => {
  const f = await desk()
  try {
    for (const data of ['5', 'e', '\r', '\u0013']) await f.send(data)
    f.io.stdout.frames = ''; await f.send('\r')
    await expect.poll(() => f.io.stdout.frames).toContain(hostSessionId)
    expect(f.io.stdout.frames).toContain('单页')
    expect(f.io.stdout.frames).toContain('当前观察')
    expect(f.session.eventCheckpoint(hostSessionId)).toBeUndefined()
    expect(f.session.intents()).toEqual([])
  } finally { await f.dispose() }
})

it('keeps invalid command fields visible and edits them to generate cards without launching a service', async () => {
  const f = await fixture(), io = tuiStreams(), results: unknown[] = [], work: Promise<unknown>[] = []
  const automation = join(f.directory, 'automation.json')
  await writeFile(automation, await readFile('examples/automation-config.json'))
  const loaded = (await readOperatorProfile(f.profilePath)).profile, profile = { ...loaded, files: { ...loaded.files, automation } }
  const instance = render(<Box flexDirection="column" width={io.stdout.columns} height={io.stdout.rows}><ConfigurationPage profile={profile} initialKind="automation" secrets={[]} environment={{}}
    onEditing={() => undefined} onResult={value => results.push(value)} onWork={value => work.push(value)} /></Box>,
  { ...io, interactive: true, exitOnCtrlC: false, patchConsole: false })
  const send = (data: string) => sendTui(io.stdin, instance, data)
  try {
    await instance.waitUntilRenderFlush()
    for (const data of ['v', '\u001b[B', 't', '\u001b[B', '\u001b[B', '\r', '\u0013', '\r']) await send(data)
    await expect.poll(() => io.stdout.frames).toContain('命令字段需为字符串')
    expect(io.stdout.frames).toContain('"triggerKey": false')
    io.stdout.frames = ''; await send('\u001b')
    await expect.poll(() => io.stdout.frames).toContain('triggerKey: false')
    for (const data of ['t', '\r', '\r', 'trigger-corrected', '\r', '\u0013', '\r']) await send(data)
    await expect.poll(() => io.stdout.frames).toContain('配置 · 文件保存与运行事实分别显示')
    await send('\u001b[6~')
    expect(io.stdout.frames).toContain('trigger-corrected')
    expect(work).toEqual([]); expect(results).toEqual([])
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy(); await rm(f.directory, { recursive: true, force: true }) }
})

it('projects only published setup steps and failures into the completed wizard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-tui-setup-result-')), profilePath = join(directory, 'operator.json'), io = tuiStreams()
  io.stdout.columns = 80; io.stdout.rows = 24
  const running = runSetupWizard(profilePath, 'local', io, {})
  const send = (data: string) => { io.stdin.write(data); io.stdin.emit('readable') }
  try {
    await expect.poll(() => io.stdout.frames).toContain('本地建立模板')
    send('\r'); await expect.poll(() => io.stdout.frames).toContain('常用部署字段')
    send('\u0013'); await expect.poll(() => io.stdout.frames).toContain('候选预览')
    send('\r'); await expect.poll(() => io.stdout.frames).toContain('local setup · profile 与完整 Host 候选')
    io.stdout.frames = ''; send('\u0013'); await expect.poll(() => io.stdout.frames).toContain('保存这些文件')
    io.stdout.frames = ''; send('\r'); await expect.poll(() => io.stdout.frames).toContain('配置已保存；尚未初始化或启动')
    await expect.poll(() => io.stdout.frames).toContain(join(directory, 'host.json'))
    expect(io.stdout.frames).toContain('已发布 host')
    expect(io.stdout.frames).toContain(join(directory, 'host.json'))
    expect(io.stdout.frames).toContain('已发布 operator')
    expect(io.stdout.frames).toContain(profilePath)
    expect(io.stdout.frames).toContain('revision')
    expect(io.stdout.frames).toContain('失败：无')
    expect(io.stdout.frames).not.toContain('maxPageBytes')
    expect(io.stdout.frames).not.toContain('maxIntents')
    expect(io.stdout.frames).toContain("'atomic-harness' 'init'")
    send('\r'); expect(await running).toBe(0)
    expect(io.stdin.raw.at(-1)).toBe(false)
  } finally { io.stdout.emit('close'); await running; io.destroy(); await rm(directory, { recursive: true, force: true }) }
})

it('shows original configuration validation errors inside the candidate preview', async () => {
  const f = await fixture(), io = tuiStreams()
  const profile = (await readOperatorProfile(f.profilePath)).profile
  const instance = render(<Box flexDirection="column" width={io.stdout.columns} height={io.stdout.rows}><ConfigurationPage profile={profile} secrets={[]} environment={{}} onEditing={() => undefined} onResult={() => undefined} onWork={() => undefined} /></Box>,
  { ...io, interactive: true, exitOnCtrlC: false, patchConsole: false })
  const send = (data: string) => sendTui(io.stdin, instance, data)
  try {
    await instance.waitUntilRenderFlush(); await send('\r')
    await expect.poll(() => io.stdout.frames).toContain('revision')
    for (const data of ['\u001b[B', '\u001b[B', 'd', '\u0013', '\r']) await send(data)
    await expect.poll(() => io.stdout.frames).toContain('HOST_CONFIG_INVALID')
    expect(io.stdout.frames).toContain('候选预览')
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy(); await rm(f.directory, { recursive: true, force: true }) }
})

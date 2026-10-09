import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { Box, render, Text } from 'ink'
import { expect, it } from 'vitest'
import { buildHostPreset } from '../src/operator/config-presets.js'
import { setupOperator } from '../src/operator/config-operations.js'
import { buildOperatorProfile, readOperatorProfile } from '../src/operator/profile.js'
import { ConfigurationPage } from '../src/tui/configuration.js'
import { runConfigEditor } from '../src/tui/wizards.js'
import { sendTui, tuiStreams } from './step15-tui-streams.js'

function readPage(frames: string, label: string) {
  const lines = stripVTControlCharacters(frames).split('\n')
  let index = lines.length - 1
  while (index >= 0 && !lines[index]!.includes(label + ' · ')) index--
  expect(index).toBeGreaterThanOrEqual(0)
  const range = lines[index]!.match(/ · (\d+)–(\d+)\/(\d+) 行/)
  expect(range).not.toBeNull()
  const first = Number(range![1]), end = Number(range![2]), total = Number(range![3])
  return { first, end, total, body: lines.slice(index + 1, index + 1 + end - first + 1).join('\n') }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'step15-tui-config-view-')), profilePath = join(directory, 'operator.json')
  await setupOperator({ profilePath, profile: buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'drain' }),
    host: buildHostPreset('solo-scripted', { hostKey: 'viewport-host', storageRoot: join(directory, 'store'), text: 'fixed' }, directory) })
  return { directory, profilePath, profile: (await readOperatorProfile(profilePath)).profile }
}

it.each([40, 80, 120])('reads every clone parameter while retaining a visible return action at %s x24', async columns => {
  const f = await fixture(), io = tuiStreams(), work: Promise<unknown>[] = []
  io.stdout.columns = columns; io.stdout.rows = 24
  const original = await readFile(f.profilePath), longDirectory = join(f.directory, '长中文路径'.repeat(200))
  const instance = render(<Box flexDirection="column" height={24} width={columns}><Text>Atomic Harness · 配置</Text>
    <Box flexDirection="column" flexGrow={1} overflowY="hidden"><ConfigurationPage profile={{ ...f.profile, directory: longDirectory }} secrets={[]} environment={{}}
      onEditing={() => undefined} onResult={() => undefined} onWork={task => work.push(task)} /></Box><Text>Ctrl+C 统一关闭</Text></Box>,
  { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await instance.waitUntilRenderFlush()
    for (const data of ['h', '\u0013', '\r']) await sendTui(io.stdin, instance, data)
    await expect.poll(() => io.stdout.frames).toContain('Clone 为新身份/存储')
    let current = readPage(io.stdout.frames, '采用内容'), body = current.body
    expect(stripVTControlCharacters(io.stdout.frames)).toContain('返回')
    while (current.end < current.total) {
      await sendTui(io.stdin, instance, '\u001b[6~'); const next = readPage(io.stdout.frames, '采用内容')
      expect(next.first).toBe(current.end + 1); body += '\n' + next.body; current = next
    }
    expect(body.replaceAll('\n', '')).toContain(JSON.stringify(join(longDirectory, 'new-host.json')).slice(1, -1))
    await sendTui(io.stdin, instance, '\u001b[B'); await sendTui(io.stdin, instance, '\r')
    await expect.poll(() => stripVTControlCharacters(io.stdout.frames).split('Atomic Harness').at(-1)).toContain('配置 · 文件保存与运行事实分别显示')
    expect(work).toEqual([]); expect(await readFile(f.profilePath)).toEqual(original)
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy(); await rm(f.directory, { recursive: true, force: true }) }
})

it.each([40, 80, 120])('pages a finite editor publication result and exits through its visible completion action at %s x24', async columns => {
  const f = await fixture(), io = tuiStreams(); io.stdout.columns = columns; io.stdout.rows = 24
  const running = runConfigEditor(f.profilePath, 'operator', io, {})
  const send = (data: string) => { io.stdin.write(data); io.stdin.emit('readable') }
  try {
    await expect.poll(() => io.stdout.frames).toContain('revision')
    send('\u0013'); await expect.poll(() => io.stdout.frames).toContain('候选预览')
    send('\r'); await expect.poll(() => io.stdout.frames).toContain('候选差异')
    send('\r'); await expect.poll(() => io.stdout.frames).toContain('配置操作结果')
    await expect.poll(() => readPage(io.stdout.frames, '动作/结果').end).toBeGreaterThan(1)
    let current = readPage(io.stdout.frames, '动作/结果'), body = current.body
    while (current.end < current.total) {
      send('\u001b[6~')
      await expect.poll(() => readPage(io.stdout.frames, '动作/结果').first).toBe(current.end + 1)
      const next = readPage(io.stdout.frames, '动作/结果'); body += '\n' + next.body; current = next
    }
    expect(body).toContain('"maxEvents"'); expect(body).toContain('"failure": null')
    expect(io.stdout.frames).toContain('结束'); expect(io.stdout.frames).toContain('继续候选编辑')
    send('\r'); expect(await running).toBe(0); expect(io.stdin.raw.at(-1)).toBe(false)
  } finally { io.stdout.emit('close'); await running; io.destroy(); await rm(f.directory, { recursive: true, force: true }) }
})

import { stripVTControlCharacters } from 'node:util'
import { Box, render, Text } from 'ink'
import { expect, it } from 'vitest'
import type { OperatorResult } from '../src/operator/types.js'
import { parseSessionId, sessionLogPosition } from '../src/session/ids.js'
import { ObservationEvidence, ResultPanel } from '../src/tui/panels.js'
import { sendTui, tuiStreams } from './step15-tui-streams.js'

it.each([['动作/结果', 5], ['事件内容', 15]])('pages every field and wrapped grapheme in the actual 80x24 %s viewport', async (label, contentRows) => {
  const io = tuiStreams(); io.stdout.columns = 80; io.stdout.rows = 24
  const longText = '长字段开始' + '中文👩‍🔬e\u0301Ａ'.repeat(40) + '长字段结束'
  const value = { ...Object.fromEntries(Array.from({ length: 280 }, (_item, index) => [`field_${String(index).padStart(3, '0')}`, `value_${index}`])), longText }
  const instance = render(<Box height={24} width={80} flexDirection="column"><Box flexGrow={1}><Text>上部面板</Text></Box><Box height={contentRows + 1} flexDirection="column">
    <ResultPanel label={label} result={value} secrets={[]} maxTextBytes={65536} /></Box></Box>, { ...io, interactive: true, exitOnCtrlC: false, patchConsole: false })
  const send = (data: string) => sendTui(io.stdin, instance, data)
  const page = () => {
    const lines = stripVTControlCharacters(io.stdout.frames).split('\n'); let index = lines.length - 1
    while (index >= 0 && !lines[index]!.startsWith(label + ' · ')) index--
    const range = lines[index]!.match(/ · (\d+)–(\d+)\/(\d+) 行/)
    return { first: Number(range![1]), end: Number(range![2]), total: Number(range![3]), body: lines.slice(index + 1, index + 1 + contentRows) }
  }
  try {
    await instance.waitUntilRenderFlush(); await expect.poll(() => io.stdout.frames).toContain(`1–${contentRows}/`)
    const pages: ReturnType<typeof page>[] = [page()]
    while (pages.at(-1)!.end < pages[0]!.total) {
      io.stdout.frames = ''; await send('\u001b[6~'); const next = page()
      expect(next.first).toBe(pages.at(-1)!.end + 1); pages.push(next)
    }
    const displayed = pages.flatMap(current => current.body).join('\n')
    for (let index = 0; index < 280; index++) expect(displayed).toContain(`"field_${String(index).padStart(3, '0')}": "value_${index}"`)
    expect(displayed.replaceAll('\n', '')).toContain(JSON.stringify(longText).slice(1, -1))
    const bottom = pages.at(-1)!
    for (let index = 0; index < 8; index++) await send('\u001b[6~')
    expect(page().first).toBe(bottom.first); expect(page().end).toBe(bottom.total)
    for (let index = pages.length - 2; index >= 0; index--) {
      io.stdout.frames = ''; await send('\u001b[5~'); expect(page().first).toBe(pages[index]!.first)
    }
    for (let index = 0; index < 8; index++) await send('\u001b[5~')
    expect(page().first).toBe(1)
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})

it('keeps event evidence in every complete frame when a measured page gains a failure summary', async () => {
  const io = tuiStreams(); io.stdout.columns = 96; io.stdout.rows = 32
  const sessionId = parseSessionId('70000000-0000-4000-8000-000000000101'), receivedAt = '2026-10-08T12:00:00.000Z'
  const last: OperatorResult = { operatorVersion: 1, kind: 'operator-result', command: 'session.events', profileKey: null, operationId: null, acceptance: 'not-applicable', status: 'ok',
    scope: { connection: 'local', connectionLifetime: 'session', hostKey: 'test-host', instanceId: null, sessionId }, receivedAt,
    cuts: [{ sessionId, through: sessionLogPosition(5) }], result: null, error: null, closing: { status: 'pending', mode: 'drain' } }
  const events = Array.from({ length: 60 }, (_item, index) => ({ field: `event-${index}`, text: '保留完整事件页面' }))
  const view = (failed: boolean) => <Box flexDirection="column" height={32} width={96}><Text>Atomic Harness</Text>
    <Box flexDirection="column" flexGrow={1} overflowY="hidden"><Box flexDirection="column" flexGrow={1}>
      <Text>事件 · {sessionId} · 固定cut 5 · {failed ? '已停止' : '观察中'}</Text><Text>本端保留 60 项 · 省略历史 0 项</Text>
      <ObservationEvidence observation={{ last: failed ? last : null, stale: failed, error: null }} />
      {failed && <Text>跟随停止 · read-failure · 读取或 checkpoint 失败；保留旧页面 · 已消费 1 页/60 项</Text>}
      <ResultPanel label="事件内容" result={events} resetKey={sessionId} maxTextBytes={65536} secrets={[]} />
    </Box></Box><Text>退出与其他操作</Text></Box>
  const instance = render(view(false), { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await instance.waitUntilRenderFlush(); await expect.poll(() => io.stdout.frames).toContain('事件内容 · 1–26/')
    io.stdout.frames = ''; instance.rerender(view(true)); await instance.waitUntilRenderFlush()
    const frames = stripVTControlCharacters(io.stdout.frames).split('Atomic Harness').filter(frame => frame.includes('read-failure'))
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      expect(frame).toContain('STALE · 保留上次核验事实')
      expect(frame).toContain(receivedAt); expect(frame).toContain(`${sessionId} @ 5`)
      expect(frame).toContain(`事件 · ${sessionId}`)
      expect(frame).toContain('本端保留 60 项 · 省略历史 0 项')
    }
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})

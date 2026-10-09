import { stripVTControlCharacters } from 'node:util'
import { Box, render, Text } from 'ink'
import type { ReactNode } from 'react'
import { expect, it } from 'vitest'
import { CollaborationPanel, ResultPanel } from '../src/tui/panels.js'
import { Picker } from '../src/tui/picker.js'
import { TreeEditor } from '../src/tui/tree.js'
import { sendTui, tuiStreams } from './step15-tui-streams.js'

const methods = ['message.send', 'message.reply', 'message.get', 'message.wait', 'delegation.spawn', 'delegation.get', 'delegation.wait', 'delegation.cancel',
  'workflow.get', 'workflow.wait', 'workflow.pause', 'workflow.resume', 'workflow.cancel', 'workflow.retry', 'workflow.output', 'workflow.artifact']

function frame(value: string): string {
  const text = stripVTControlCharacters(value)
  return text.slice(text.lastIndexOf('Atomic Harness'))
}
function shell(columns: number, node: ReactNode, result = false) {
  return <Box flexDirection="column" height={24} width={columns}>
    <Text>Atomic Harness · 1概览 2任务 3协作 4配置 5事件 · local · collaboration</Text>
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">{node}</Box>
    {result && <Box flexDirection="column" height={6} overflowY="hidden"><ResultPanel result={{ method: 'workflow.get', value: 'a' }} maxTextBytes={65536} secrets={[]} /></Box>}
    <Text wrap="truncate">j 操作记录 · u 原输入恢复 · b 有限run · s 显式host stop · q 退出 · Ctrl+C 统一关闭</Text>
  </Box>
}

it.each([40, 80, 120])('keeps the selected collaboration method, heading and action keys visible at %s x24', async columns => {
  const io = tuiStreams(); io.stdout.columns = columns; io.stdout.rows = 24
  const instance = render(shell(columns, <CollaborationPanel methods={methods} selected={15} agentKey="coordinator" remote />, true),
    { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await instance.waitUntilRenderFlush()
    await expect.poll(() => frame(io.stdout.frames)).toContain('workflow.artifact')
    expect(frame(io.stdout.frames)).toContain('通信 / Child / Workflow')
    expect(frame(io.stdout.frames)).toContain('Enter')
    instance.rerender(shell(columns, <CollaborationPanel methods={methods} selected={0} agentKey="coordinator" remote />, true))
    await instance.waitUntilRenderFlush()
    await expect.poll(() => frame(io.stdout.frames)).toContain('message.send')
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})

it.each([40, 80, 120])('reads the complete selected exact-target label and returns through a bounded menu at %s x24', async columns => {
  const io = tuiStreams(); io.stdout.columns = columns; io.stdout.rows = 24
  const labels = Array.from({ length: 16 }, (_item, index) => `${index} 70000000-0000-4000-8000-000000000101 · ordinary · 中文研究任务未结算`)
  const selected: number[] = [], cancelled: boolean[] = []
  const instance = render(shell(columns, <Picker title="选择当前报告的精确 Root" items={labels.map((label, value) => ({ label, value }))}
    onSelect={value => selected.push(value)} onCancel={() => cancelled.push(true)} />), { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await instance.waitUntilRenderFlush()
    for (let index = 0; index < 15; index++) await sendTui(io.stdin, instance, '\u001b[B')
    expect(frame(io.stdout.frames)).toContain('选择当前报告的精确 Root')
    expect(frame(io.stdout.frames)).toContain('16/16')
    expect(frame(io.stdout.frames).replace(/\s+/g, '')).toContain(labels[15]!.replace(/\s+/g, ''))
    await sendTui(io.stdin, instance, '\r'); expect(selected).toEqual([15])
    await sendTui(io.stdin, instance, '\u001b'); await expect.poll(() => cancelled).toEqual([true])
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})

it.each([40, 80, 120])('pages every wrapped candidate cell before adopting the unchanged value at %s x24', async columns => {
  const io = tuiStreams(); io.stdout.columns = columns; io.stdout.rows = 24
  const original = { first: '中文👩‍🔬e\u0301Ａ'.repeat(120) + '字段结尾必须可读', second: 'tail-must-be-readable' }, adopted: unknown[] = []
  const instance = render(shell(columns, <TreeEditor title="候选结构预览" initial={original} maxTextBytes={65536} secrets={[]}
    onSubmit={value => adopted.push(value)} onCancel={() => undefined} />), { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  const page = () => {
    const lines = frame(io.stdout.frames).split('\n'), index = lines.findIndex(line => line.startsWith('候选数据 · '))
    expect(index).toBeGreaterThanOrEqual(0)
    const range = lines[index]!.match(/ · (\d+)–(\d+)\/(\d+) 行/)
    expect(range).not.toBeNull()
    const first = Number(range![1]), end = Number(range![2]), total = Number(range![3])
    return { first, end, total, body: lines.slice(index + 1, index + 1 + end - first + 1).join('\n') }
  }
  try {
    await instance.waitUntilRenderFlush(); await sendTui(io.stdin, instance, '\u0013')
    let current = page(), body = current.body
    while (current.end < current.total) {
      await sendTui(io.stdin, instance, '\u001b[6~'); const next = page()
      expect(next.first).toBe(current.end + 1); body += '\n' + next.body; current = next
    }
    expect(body.replaceAll('\n', '')).toContain(JSON.stringify(original.first).slice(1, -1))
    expect(body).toContain(original.second)
    for (let index = 0; index < 8; index++) await sendTui(io.stdin, instance, '\u001b[6~')
    expect(page().end).toBe(current.total)
    await sendTui(io.stdin, instance, '\u001b'); await expect.poll(() => frame(io.stdout.frames)).toContain('Ctrl+S')
    expect(adopted).toEqual([])
    await sendTui(io.stdin, instance, '\u0013'); await sendTui(io.stdin, instance, '\r')
    expect(adopted).toEqual([original])
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})

import { rm } from 'node:fs/promises'
import { stripVTControlCharacters } from 'node:util'
import { Box, render, Text } from 'ink'
import { expect, it } from 'vitest'
import type { AgentObservation, HostStatusResult, RootObservation } from '../src/protocol/index.js'
import { openOperatorSession } from '../src/operator/session.js'
import type { OperatorResult } from '../src/operator/types.js'
import { formatSessionEventId, parseSessionId, sessionLogPosition, sessionSequence } from '../src/session/ids.js'
import type { ReactNode } from 'react'
import type { JsonObject, JsonValue } from '../src/foundation/json.js'
import { EffectOwner } from '../src/effect/owner.js'
import { OverviewPanel, TasksPanel } from '../src/tui/panels.js'
import { TaskComposer } from '../src/tui/task.js'
import { TuiApp } from '../src/tui/app.js'
import type { DisplayObservation } from '../src/tui/observation.js'
import { localFixture } from './step15-operator-fixture.js'
import { hostConfig } from './host/fixtures.js'
import { sendTui, tuiStreams } from './step15-tui-streams.js'

function frame(frames: string) {
  const value = stripVTControlCharacters(frames)
  return value.slice(value.lastIndexOf('Atomic Harness'))
}
function page(frames: string, label: string) {
  const lines = frame(frames).split('\n'), index = lines.findIndex(line => line.startsWith(label + ' · '))
  expect(index).toBeGreaterThanOrEqual(0)
  const match = lines[index]!.match(/ · (\d+)–(\d+)\/(\d+) 行/)
  expect(match).not.toBeNull()
  const first = Number(match![1]), end = Number(match![2]), total = Number(match![3])
  return { first, end, total, body: lines.slice(index + 1, index + 1 + end - first + 1).join('\n') }
}
const observation = (last: OperatorResult): DisplayObservation => ({ last, stale: false, error: null })
function shell(columns: number, children: ReactNode) {
  return <Box width={columns} height={24} flexDirection="column"><Text>Atomic Harness · 当前观察</Text>
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">{children}</Box><Text>Ctrl+C 统一关闭</Text></Box>
}

it.each([40, 80, 120])('pages many members while keeping the selected member and fresh observation evidence at %s x24', async columns => {
  const f = await localFixture(), session = await openOperatorSession(f.profilePath, { lifetime: 'session' }), io = tuiStreams()
  io.stdout.columns = columns; io.stdout.rows = 24
  const original = await session.execute('host.status', {}), result = original.result as HostStatusResult
  const members = Array.from({ length: 64 }, (_item, index) => ({ ...result.report.members[0]!, agentKey: `member-${String(index).padStart(2, '0')}`,
    sessionId: parseSessionId(`70000000-0000-4000-8000-${String(index + 200).padStart(12, '0')}`) }))
  const cuts = members.map((member, index) => ({ sessionId: member.sessionId, through: sessionLogPosition(index) }))
  let last: OperatorResult = { ...original, receivedAt: '2026-10-08T12:00:00.000Z', cuts, result: { ...result, cuts, report: { ...result.report, configuredMembers: 64, members, cuts } } }
  const view = () => shell(columns, <OverviewPanel session={session} observation={observation(last)} selectedAgent="member-63" secrets={[]} />)
  const instance = render(view(), { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await instance.waitUntilRenderFlush()
    expect(frame(io.stdout.frames)).toContain('概览')
    expect(frame(io.stdout.frames)).toContain('2026-10-08T12:00:00.000Z')
    expect(frame(io.stdout.frames)).toContain('member-63')
    let current = page(io.stdout.frames, 'Host 详情'), body = current.body
    while (current.end < current.total) {
      await sendTui(io.stdin, instance, '\u001b[6~'); const next = page(io.stdout.frames, 'Host 详情')
      expect(next.first).toBe(current.end + 1); body += '\n' + next.body; current = next
    }
    for (const member of members) expect(body).toContain(member.agentKey)
    for (const cut of cuts) expect(body.replaceAll('\n', '')).toContain(`${cut.sessionId} @ ${cut.through}`)
    last = { ...last, receivedAt: '2026-10-08T12:00:01.000Z' }; instance.rerender(view()); await instance.waitUntilRenderFlush()
    expect(frame(io.stdout.frames)).toContain(last.receivedAt)
    expect(page(io.stdout.frames, 'Host 详情').first).toBe(current.first)
    expect(frame(io.stdout.frames)).toContain('↑↓ 选成员')
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy(); await session.close(); await rm(f.directory, { recursive: true, force: true }) }
})

it.each([40, 80, 120])('keeps actual desk observation pages while Tab gives the full original receipt the only paging focus at %s x24', async columns => {
  const long = '实际科研段落 中文👩‍🔬e\u0301Ａ'.repeat(80) + '真实正文结尾'
  const f = await localFixture(root => {
    const value = hostConfig(root), member = (value.members as readonly JsonValue[])[0] as JsonObject
    return { ...value, members: [{ ...member, model: { ...member.model as JsonObject, text: long } }] }
  }), session = await openOperatorSession(f.profilePath, { lifetime: 'session' }), io = tuiStreams()
  io.stdout.columns = columns; io.stdout.rows = 24
  await session.submit({ agentKey: 'writer', text: '生成真实长科研final', drive: true })
  const owner = new EffectOwner('viewport-desk'), abort = new AbortController(), closed: unknown[] = []
  const instance = render(<TuiApp session={session} owner={owner} signal={abort.signal} secrets={[]} environment={{}}
    onClose={mode => closed.push(mode)} onConfigurationWork={() => undefined} />,
  { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await expect.poll(() => io.stdout.frames).toContain('test-host')
    await sendTui(io.stdin, instance, '2'); await sendTui(io.stdin, instance, 'r')
    await expect.poll(() => frame(io.stdout.frames)).toContain('选择当前报告的精确 Root')
    await sendTui(io.stdin, instance, '\r')
    await expect.poll(() => frame(io.stdout.frames)).toContain('精确 Root')
    await expect.poll(() => frame(io.stdout.frames)).toContain('Tab 回执')
    let current = page(io.stdout.frames, '任务详情'), body = current.body
    while (current.end < current.total) {
      await sendTui(io.stdin, instance, '\u001b[6~'); const next = page(io.stdout.frames, '任务详情')
      expect(next.first).toBe(current.end + 1); body += '\n' + next.body; current = next
      expect(frame(io.stdout.frames)).toContain('当前观察')
      expect(frame(io.stdout.frames)).toContain('精确 Root')
      expect(frame(io.stdout.frames)).toContain('q 退出 · Ctrl+C 关闭')
      expect(frame(io.stdout.frames)).toContain('n 写任务')
    }
    expect(body.replace(/\s+/g, '')).toContain(long.replace(/\s+/g, ''))
    while (page(io.stdout.frames, '任务详情').first > 1) await sendTui(io.stdin, instance, '\u001b[5~')
    await sendTui(io.stdin, instance, '\u001b[6~')
    const beforeFocus = page(io.stdout.frames, '任务详情').first
    expect(beforeFocus).toBeGreaterThan(1)
    await sendTui(io.stdin, instance, '\t')
    expect(frame(io.stdout.frames)).toContain('回执全文')
    for (let index = 0; index < 25; index++) await sendTui(io.stdin, instance, '\u001b[6~')
    expect(page(io.stdout.frames, '回执全文 · Tab/Esc 返回').first).toBeGreaterThan(1)
    await sendTui(io.stdin, instance, '\t')
    await expect.poll(() => page(io.stdout.frames, '任务详情').first).toBe(beforeFocus)
    await sendTui(io.stdin, instance, 'n'); await sendTui(io.stdin, instance, '\t')
    expect(frame(io.stdout.frames)).toContain('提交并运行一批')
    expect(frame(io.stdout.frames)).not.toContain('回执全文')
    await sendTui(io.stdin, instance, '\u001b')
    await expect.poll(() => frame(io.stdout.frames)).toContain('任务与对话')
    await sendTui(io.stdin, instance, 'q'); await sendTui(io.stdin, instance, '\r')
    expect(closed).toEqual(['drain'])
  } finally { abort.abort(); instance.unmount(); await instance.waitUntilExit(); await owner.dispose(); io.destroy(); await session.close(); await rm(f.directory, { recursive: true, force: true }) }
})

it.each([40, 80, 120])('reads long finals and exact waits with fixed evidence and controls at %s x24', async columns => {
  const f = await localFixture(), session = await openOperatorSession(f.profilePath, { lifetime: 'session' }), io = tuiStreams()
  io.stdout.columns = columns; io.stdout.rows = 24
  await session.submit({ agentKey: 'writer', text: '产生实际Root供显示审计', drive: true })
  const agentLast = await session.execute('agent.get', { agentKey: 'writer' }), agent = agentLast.result as AgentObservation
  const rootLast = await session.execute('root.get', { agentKey: 'writer', rootId: agent.report.roots[0]!.id }), originalRoot = rootLast.result as RootObservation
  const long = '研究正文 中文👩‍🔬e\u0301Ａ'.repeat(200) + '论文正文结尾必须可读'
  const root: RootObservation = { ...originalRoot, final: { ...originalRoot.final!, text: long }, waits: [{ reference: { eventId: originalRoot.rootId, index: 0 },
    descriptor: { kind: 'user', root: originalRoot.rootId, question: '核验后的精确问题 中文格式？', deadline: '2099-01-01T00:00:00.000Z', observedAt: '2026-10-08T12:00:00.000Z', protectedTurns: [] } }] }
  const shownAgent: OperatorResult = { ...agentLast, receivedAt: '2026-10-08T12:00:00.000Z', result: { ...agent, report: { ...agent.report, final: { ...agent.report.final!, text: long } } } }
  const shownRoot: OperatorResult = { ...rootLast, receivedAt: '2026-10-08T12:00:00.000Z', result: root }
  const instance = render(shell(columns, <TasksPanel observation={observation(shownAgent)} root={root} rootObservation={observation(shownRoot)} maxTextBytes={65536} secrets={[]} />),
    { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await instance.waitUntilRenderFlush()
    expect(frame(io.stdout.frames)).toContain('任务与对话')
    expect(frame(io.stdout.frames)).toContain('精确 Root')
    expect(frame(io.stdout.frames)).toContain('2026-10-08T12:00:00.000Z')
    let current = page(io.stdout.frames, '任务详情'), body = current.body
    while (current.end < current.total) {
      await sendTui(io.stdin, instance, '\u001b[6~'); const next = page(io.stdout.frames, '任务详情')
      expect(next.first).toBe(current.end + 1); body += '\n' + next.body; current = next
      expect(frame(io.stdout.frames)).toContain('n 写任务')
      expect(frame(io.stdout.frames)).toContain('a 回答')
    }
    expect(body).toContain('核验后的精确问题')
    expect(body.replace(/\s+/g, '')).toContain(long.replace(/\s+/g, ''))
    expect(body.replaceAll('\n', '')).toContain(`${root.rootId}:0`)
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy(); await session.close(); await rm(f.directory, { recursive: true, force: true }) }
})

it.each([40, 80, 120])('reads a long exact question while keeping the answer field and explicit submit keys visible at %s x24', async columns => {
  const io = tuiStreams(); io.stdout.columns = columns; io.stdout.rows = 24
  const wait = { eventId: formatSessionEventId(parseSessionId('70000000-0000-4000-8000-000000000101'), sessionSequence(3)), index: 0 }
  const question = '科研需求 中文👩‍🔬e\u0301Ａ'.repeat(120) + '完整问题结尾', submitted: unknown[] = []
  const instance = render(shell(columns, <TaskComposer agentKey="writer" wait={wait} question={question} secrets={[]}
    onSubmit={(text, drive) => submitted.push({ text, drive })} onCancel={() => undefined} />),
  { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await instance.waitUntilRenderFlush()
    expect(frame(io.stdout.frames)).toContain('回答 user wait')
    expect(frame(io.stdout.frames)).toContain('多行文本')
    expect(frame(io.stdout.frames)).toContain('Ctrl+S')
    let current = page(io.stdout.frames, '精确 user wait'), body = current.body
    while (current.end < current.total) {
      await sendTui(io.stdin, instance, '\u001b[6~'); const next = page(io.stdout.frames, '精确 user wait')
      expect(next.first).toBe(current.end + 1); body += '\n' + next.body; current = next
      expect(frame(io.stdout.frames)).toContain('Ctrl+S'); expect(frame(io.stdout.frames)).toContain('Esc')
    }
    expect(body.replace(/\s+/g, '')).toContain(question.replace(/\s+/g, ''))
    expect(body.replaceAll('\n', '')).toContain(`${wait.eventId}:${wait.index}`)
    const answer = '中文回答q\n👩‍🔬e\u0301Ａ'
    await sendTui(io.stdin, instance, `\u001b[200~${answer}\u001b[201~`)
    expect(submitted).toEqual([])
    await sendTui(io.stdin, instance, '\u0013'); expect(submitted).toEqual([{ text: answer, drive: false }])
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})

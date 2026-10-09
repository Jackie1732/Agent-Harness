/** Read-only pages distinguish independently observed facts, budgets and resource settlement. */
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useBoxMetrics, useInput, useWindowSize } from 'ink'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'
import type { AgentObservation, HostStatusResult, RootObservation } from '../protocol/index.js'
import type { OperatorSession } from '../operator/types.js'
import type { DisplayObservation } from './observation.js'
import { displayText, displayValue, plainText } from './text.js'
import { powershellCommand } from './command-cards.js'
import type { CommandCard } from './command-cards.js'
import { graphemes } from './draft.js'

/** @param observation Last result and stale state. @returns Evidence labels without a global-snapshot claim. */
export function ObservationEvidence({ observation, secrets, compact = false, focusSessionId }: {
  readonly observation: DisplayObservation; readonly secrets?: readonly string[]; readonly compact?: boolean; readonly focusSessionId?: string
}) {
  const cuts = observation.last?.cuts ?? [], visible = compact ? focusSessionId === undefined ? cuts.length === 1 ? cuts : [] : cuts.filter(cut => cut.sessionId === focusSessionId) : cuts
  return <Box flexDirection="column" flexShrink={0}>
    <Text color={observation.stale ? 'yellow' : 'cyan'}>{observation.stale ? 'STALE · 保留上次核验事实' : '当前观察'} · {observation.last?.receivedAt ?? '尚未收到'}</Text>
    {visible.map(cut => <Text key={cut.sessionId} dimColor>{plainText(cut.sessionId)} @ {cut.through}</Text>)}
    {visible.length < cuts.length && <Text dimColor wrap="truncate">cuts {cuts.length} · 全部证据见分页详情</Text>}
    {observation.error !== null && <Text color="red" {...(compact ? { wrap: 'truncate' as const } : {})}>{plainText(observation.error.code, secrets)} · {plainText(observation.error.message, secrets)}</Text>}
  </Box>
}

/** @param props Actual Host observation and explicit connection profile. @returns Current Host counters and member facts. */
export function OverviewPanel(props: { readonly session: OperatorSession; readonly observation: DisplayObservation; readonly selectedAgent: string | null; readonly secrets: readonly string[]; readonly isActive?: boolean }) {
  const status = props.observation.last?.result as HostStatusResult | undefined
  const profile = props.session.profile, selected = status?.report.members.find(member => member.agentKey === props.selectedAgent)
  const text = status === undefined ? '尚未收到 Host 观察' : [
    `选中成员 ${props.selectedAgent ?? '尚未选择'}${selected === undefined ? '' : ` · ${selected.mailbox} · ${selected.paused ? 'paused' : 'active'} · ${selected.readiness.blockedBy}`}`,
    `Host ${status.report.hostKey} · ${status.hostStatus} · ${status.activity} · 协议 ${status.report.configVersion}`,
    `instance ${status.instanceId} · 已加载配置 ${status.report.configFingerprint}`,
    `成员 ${status.report.configuredMembers} · 输入 ${status.report.counts.pendingInputs} · 等待 ${status.report.counts.pendingWaits} · Outbox ${status.report.counts.pendingOutbox} · 恢复/阻塞 ${status.report.counts.blockedMembers}`,
    `未结算操作 ${status.report.unfinishedOperations} · 关闭超期 ${String(status.report.shutdownOverdue)}`,
    ...status.report.members.map(member => `${member.agentKey} · ${member.mailbox} · ${member.paused ? 'paused' : 'active'} · ${member.faulted ? 'faulted' : 'healthy'} · ${member.readiness.blockedBy}`),
    ...(status.report.truncated ? ['成员报告已截断；配置列表和精确查询保留完整入口'] : []),
    ...(status.report.blockedRoutes.length === 0 ? [] : [`阻塞路由 ${status.report.blockedRoutes.join(', ')}`]),
    '观察 cuts：', ...(props.observation.last?.cuts ?? []).map(cut => `${cut.sessionId} @ ${cut.through}`),
    ...(props.observation.error === null ? [] : [displayValue(props.observation.error, profile.display.maxTextBytes, props.secrets)]),
  ].join('\n')
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={3}>
    <Box flexDirection="column" flexShrink={0}><Text bold wrap="truncate">概览 · {profile.connection.kind === 'local' ? '本端拥有 Host' : '接入已有服务器'} · 长存连接</Text>
      <Text wrap="truncate">{plainText(profile.profilePath, props.secrets)}</Text></Box>
    <ObservationEvidence observation={props.observation} secrets={props.secrets} compact {...(selected === undefined ? {} : { focusSessionId: selected.sessionId })} />
    <ResultPanel label="Host 详情" text={text} resetKey={props.selectedAgent} maxTextBytes={profile.display.maxTextBytes} secrets={props.secrets} isActive={props.isActive ?? true} />
    <Box flexShrink={0}><Text dimColor wrap="truncate">↑↓ 选成员 · 2 任务 · 3 协作 · 4 配置</Text></Box>
  </Box>
}

/** @param props Selected actual member and optional exact Root observation. @returns Task/wait/final and resource facts. */
export function TasksPanel(props: { readonly observation: DisplayObservation; readonly root: RootObservation | null; readonly rootObservation: DisplayObservation; readonly maxTextBytes: number; readonly secrets: readonly string[]; readonly isActive?: boolean }) {
  const agent = props.observation.last?.result as AgentObservation | undefined
  const root = props.root, text = [
    ...(root === null ? [] : [`Root ${root.rootId} · ${root.outcome ?? '未结算'} · executionPending ${String(root.executionPending)}`,
      ...root.waits.map(wait => `wait ${wait.reference.eventId}:${wait.reference.index} · ${wait.descriptor.kind} ${wait.descriptor.kind === 'user' ? wait.descriptor.question : ''}`),
      ...(root.final === null ? [] : ['精确 Root 最终结果：', root.final.text ?? '[正文省略]']),
      'Root cuts：', ...(props.rootObservation.last?.cuts ?? []).map(cut => `${cut.sessionId} @ ${cut.through}`)]),
    ...(agent === undefined ? ['尚未收到成员观察'] : [
      `${agent.sessionId} · ${agent.mailbox} · 恢复 ${String(agent.recoveryRequired)} · readiness ${agent.readiness.blockedBy}`,
      `输入 ${agent.report.counts.pendingInputs} · user/peer 等待 ${agent.report.counts.pendingWaits} · 失败Root ${agent.report.counts.failedRoots}`,
      ...agent.report.roots.map(item => `Root ${item.id} · ${item.source.kind} · ${item.outcome ?? '未结算'} · ${item.reason ?? ''}`),
      ...(agent.report.final === null ? [] : ['成员最近最终结果：', agent.report.final.text ?? '[原结果正文省略]']),
      ...(Object.values(agent.report.truncated).some(Boolean) ? ['报告截断；r 查询精确 Root，e 分页事件'] : [])]),
    '成员 cuts：', ...(props.observation.last?.cuts ?? []).map(cut => `${cut.sessionId} @ ${cut.through}`),
    ...(props.observation.error === null ? [] : [displayValue(props.observation.error, props.maxTextBytes, props.secrets)]),
    ...(props.rootObservation.error === null ? [] : [displayValue(props.rootObservation.error, props.maxTextBytes, props.secrets)]),
  ].join('\n')
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={3}>
    <Box flexShrink={0}><Text bold wrap="truncate">任务与对话 · {plainText(agent?.agentKey ?? '先选择成员', props.secrets)}</Text></Box>
    <ObservationEvidence observation={props.observation} secrets={props.secrets} compact {...(agent === undefined ? {} : { focusSessionId: agent.sessionId })} />
    {root !== null && <><Box flexShrink={0}><Text color="cyan" wrap="truncate">精确 Root · {root.outcome ?? '未结算'} · executionPending {String(root.executionPending)}</Text></Box>
      <ObservationEvidence observation={props.rootObservation} secrets={props.secrets} compact focusSessionId={root.sessionId} /></>}
    <ResultPanel label="任务详情" text={text} resetKey={root?.rootId ?? agent?.agentKey} maxTextBytes={props.maxTextBytes} secrets={props.secrets} isActive={props.isActive ?? true} />
    <Box flexDirection="column" flexShrink={0}><Text dimColor wrap="truncate">n 写任务 · a 回答 · r 选择精确Root</Text>
      <Text dimColor wrap="truncate">x 取消 · b 有限run · p 暂停/恢复 · e 事件</Text></Box>
  </Box>
}

/** @param props Available original methods and selected exact targets. @returns All collaboration operation entries. */
export function CollaborationPanel(props: { readonly methods: readonly string[]; readonly selected: number; readonly agentKey: string | null; readonly remote: boolean }) {
  const viewport = useRef<DOMElement | null>(null), metrics = useBoxMetrics(viewport)
  const count = Math.max(1, Math.floor(metrics.clientHeight)), first = Math.max(0, props.selected - count + 1)
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={3}>
    <Box flexDirection="column" flexShrink={0}><Text bold wrap="truncate">通信 / Child / Workflow · {plainText(props.agentKey ?? '完整结构输入')}</Text>
      {props.remote && <><Text color="yellow" wrap="truncate">远端不提供授权/模板发现</Text><Text color="yellow" wrap="truncate">完整参数须明确提供；列表不证明授权</Text></>}</Box>
    <Box ref={viewport} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={1} overflowY="hidden">
      {props.methods.slice(first, first + count).map((method, index) => <Text key={method} inverse={first + index === props.selected} wrap="truncate">{method}</Text>)}
    </Box>
    <Box flexShrink={0}><Text dimColor wrap="truncate">↑↓ 选择 · Enter 参数 · Ctrl+S 预览</Text></Box>
  </Box>
}

/** @param props Original result and optional stable event target. @returns Cell-wrapped pages using the measured content viewport. */
export function ResultPanel(props: ({ readonly result: unknown; readonly text?: never } | { readonly text: string; readonly result?: never }) & {
  readonly maxTextBytes: number; readonly secrets: readonly string[]; readonly label?: string; readonly resetKey?: unknown; readonly scrollArrows?: boolean; readonly isActive?: boolean
}) {
  const [offset, setOffset] = useState(0), viewport = useRef<DOMElement | null>(null), metrics = useBoxMetrics(viewport), { columns } = useWindowSize()
  const width = Math.max(1, Math.floor(metrics.clientWidth || columns)), height = Math.max(1, Math.floor(metrics.clientHeight))
  const text = props.text === undefined ? displayValue(props.result, props.maxTextBytes, props.secrets) : displayText(props.text, props.maxTextBytes, props.secrets)
  const lines = text.split('\n').flatMap(line => {
    const wrapped: string[] = []; let content = '', cells = 0
    for (const part of graphemes(line)) {
      const size = stringWidth(part)
      if (cells + size > width && content.length > 0) { wrapped.push(content); content = ''; cells = 0 }
      content += part; cells += size
    }
    wrapped.push(content); return wrapped
  })
  const last = Math.floor((lines.length - 1) / height) * height, first = Math.min(Math.floor(offset / height) * height, last)
  useEffect(() => { setOffset(0) }, [props.resetKey ?? props.result ?? props.text])
  useInput((_input, key) => {
    if (key.pageDown || props.scrollArrows && key.downArrow) setOffset(current => Math.min(last, Math.floor(Math.min(current, last) / height) * height + height))
    else if (key.pageUp || props.scrollArrows && key.upArrow) setOffset(current => Math.max(0, Math.floor(Math.min(current, last) / height) * height - height))
  }, { isActive: props.isActive ?? true })
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={2}><Text bold wrap="truncate">{props.label ?? '动作/结果'} · {first + 1}–{Math.min(lines.length, first + height)}/{lines.length} 行 · PgUp/PgDn 滚动</Text>
    <Box ref={viewport} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={1} overflowY="hidden"><Text wrap="truncate">{lines.slice(first, first + height).join('\n')}</Text></Box></Box>
}

/** @param props Exact commands and result locations. @returns Copyable argv/PowerShell cards for another terminal. */
export function CommandCardsPanel(props: { readonly cards: readonly CommandCard[]; readonly maxTextBytes: number; readonly secrets?: readonly string[] }) {
  const lines = props.cards.flatMap(card => [plainText(card.label, props.secrets) + ' · 结果/配置位置 ' + plainText(card.location, props.secrets),
    ...displayValue(card.argv, props.maxTextBytes, props.secrets).split('\n'), plainText(powershellCommand(card.argv), props.secrets)])
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={3}>
    <ResultPanel label="另一终端执行的原命令" text={lines.length === 0 ? '先建立或登记配置；c 创建，l 登记，Enter 编辑' : lines.join('\n')} maxTextBytes={props.maxTextBytes} secrets={props.secrets ?? []} />
    <Box flexShrink={0}><Text dimColor wrap="truncate">卡片只显示命令；服务由另一终端拥有</Text></Box></Box>
}

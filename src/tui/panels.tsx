/** Read-only pages distinguish independently observed facts, budgets and resource settlement. */
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useBoxMetrics, useInput, useWindowSize } from 'ink'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'
import type { AgentObservation, HostStatusResult, RootObservation } from '../protocol/index.js'
import type { OperatorResult, OperatorSession } from '../operator/types.js'
import type { DisplayObservation } from './observation.js'
import { displayValue, plainText } from './text.js'
import { powershellCommand } from './command-cards.js'
import type { CommandCard } from './command-cards.js'
import { graphemes } from './draft.js'

/** @param observation Last result and stale state. @returns Evidence labels without a global-snapshot claim. */
export function ObservationEvidence({ observation, secrets }: { readonly observation: DisplayObservation; readonly secrets?: readonly string[] }) {
  return <Box flexDirection="column" flexShrink={0}>
    <Text color={observation.stale ? 'yellow' : 'cyan'}>{observation.stale ? 'STALE · 保留上次核验事实' : '当前观察'} · {observation.last?.receivedAt ?? '尚未收到'}</Text>
    {observation.last?.cuts?.map(cut => <Text key={cut.sessionId} dimColor>{plainText(cut.sessionId)} @ {cut.through}</Text>)}
    {observation.error !== null && <Text color="red">{plainText(observation.error.code, secrets)} · {plainText(observation.error.message, secrets)}</Text>}
  </Box>
}

/** @param props Actual Host observation and explicit connection profile. @returns Current Host counters and member facts. */
export function OverviewPanel(props: { readonly session: OperatorSession; readonly observation: DisplayObservation; readonly selectedAgent: string | null; readonly secrets: readonly string[] }) {
  const status = props.observation.last?.result as HostStatusResult | undefined
  const profile = props.session.profile
  return <Box flexDirection="column">
    <Text bold>概览 · {profile.connection.kind === 'local' ? '本端拥有 Host' : '接入已有服务器'} · 长存连接</Text>
    <Text>{plainText(profile.profilePath, props.secrets)}</Text>
    <ObservationEvidence observation={props.observation} secrets={props.secrets} />
    {status !== undefined && <>
      <Text>Host {plainText(status.report.hostKey, props.secrets)} · {status.hostStatus} · {status.activity} · 协议 {status.report.configVersion}</Text>
      <Text dimColor>instance {plainText(status.instanceId)} · 已加载配置 {plainText(status.report.configFingerprint)}</Text>
      <Text>成员 {status.report.configuredMembers} · 输入 {status.report.counts.pendingInputs} · 等待 {status.report.counts.pendingWaits} · Outbox {status.report.counts.pendingOutbox} · 恢复/阻塞 {status.report.counts.blockedMembers}</Text>
      <Text>未结算操作 {status.report.unfinishedOperations} · 关闭超期 {String(status.report.shutdownOverdue)}</Text>
      {status.report.members.map(member => <Text key={member.agentKey} inverse={member.agentKey === props.selectedAgent} wrap="truncate">
        {plainText(member.agentKey, props.secrets)} · {member.mailbox} · {member.paused ? 'paused' : 'active'} · {member.faulted ? 'faulted' : 'healthy'} · {member.readiness.blockedBy}
      </Text>)}
      {status.report.truncated && <Text color="yellow">成员报告已截断；配置列表和精确查询保留完整入口</Text>}
      {status.report.blockedRoutes.length > 0 && <Text color="yellow">阻塞路由 {plainText(status.report.blockedRoutes.join(', '), props.secrets)}</Text>}
    </>}
    <Text dimColor>↑↓ 选成员 · 2 任务 · 3 协作 · 4 配置 · q 退出面板</Text>
  </Box>
}

/** @param props Selected actual member and optional exact Root observation. @returns Task/wait/final and resource facts. */
export function TasksPanel(props: { readonly observation: DisplayObservation; readonly root: RootObservation | null; readonly rootObservation: DisplayObservation; readonly maxTextBytes: number; readonly secrets: readonly string[] }) {
  const agent = props.observation.last?.result as AgentObservation | undefined
  return <Box flexDirection="column">
    <Text bold>任务与对话 · {plainText(agent?.agentKey ?? '先选择成员', props.secrets)}</Text>
    <ObservationEvidence observation={props.observation} secrets={props.secrets} />
    {agent !== undefined && <>
      <Text>{plainText(agent.sessionId)} · {agent.mailbox} · 恢复 {String(agent.recoveryRequired)} · readiness {agent.readiness.blockedBy}</Text>
      <Text>输入 {agent.report.counts.pendingInputs} · user/peer 等待 {agent.report.counts.pendingWaits} · 失败Root {agent.report.counts.failedRoots}</Text>
      {agent.report.roots.map(root => <Text key={root.id} wrap="truncate">Root {root.id} · {root.source.kind} · {root.outcome ?? '未结算'} · {plainText(root.reason ?? '', props.secrets)}</Text>)}
      {agent.report.final !== null && <Text>{plainText(agent.report.final.text ?? '[原结果正文省略]', props.secrets)}</Text>}
      {Object.values(agent.report.truncated).some(Boolean) && <Text color="yellow">报告截断；r 查询精确 Root，e 分页事件</Text>}
    </>}
    {props.root !== null && <>
      <Text color="cyan">精确 Root {props.root.rootId} · {props.root.outcome ?? '未结算'} · executionPending {String(props.root.executionPending)}</Text>
      <ObservationEvidence observation={props.rootObservation} secrets={props.secrets} />
      {props.root.waits.map(wait => <Text key={wait.reference.eventId + ':' + wait.reference.index}>
        wait {wait.reference.eventId}:{wait.reference.index} · {wait.descriptor.kind} {wait.descriptor.kind === 'user' ? plainText(wait.descriptor.question, props.secrets) : ''}
      </Text>)}
      {props.root.final !== null && <Text>{plainText(props.root.final.text ?? '[正文省略]', props.secrets)}</Text>}
      <Text dimColor>{displayValue(props.root.cuts, props.maxTextBytes, props.secrets)}</Text>
    </>}
    <Text dimColor>n 写任务 · a 回答精确 user wait · r 选择Root · x 取消精确Root · b 运行一批 · p 暂停/恢复成员 · e 事件</Text>
  </Box>
}

/** @param props Available original methods and selected exact targets. @returns All collaboration operation entries. */
export function CollaborationPanel(props: { readonly methods: readonly string[]; readonly selected: number; readonly agentKey: string | null; readonly remote: boolean }) {
  return <Box flexDirection="column">
    <Text bold>通信 / Child / Workflow · {plainText(props.agentKey ?? '完整结构输入')}</Text>
    {props.remote && <Text color="yellow">远端无 grants/schema/template discovery；完整参数须明确提供，导航列表不证明授权</Text>}
    {props.methods.map((method, index) => <Text key={method} inverse={index === props.selected}>{method}</Text>)}
    <Text dimColor>↑↓ 选择 · Enter 打开完整字段结构 · Ctrl+S 预览/确认 · 查询与wait不会运行Host</Text>
  </Box>
}

/** @param props Original result and optional stable event target. @returns Cell-wrapped pages using the measured content viewport. */
export function ResultPanel(props: { readonly result: OperatorResult | unknown; readonly maxTextBytes: number; readonly secrets: readonly string[]; readonly label?: string; readonly resetKey?: unknown }) {
  const [offset, setOffset] = useState(0), viewport = useRef<DOMElement | null>(null), metrics = useBoxMetrics(viewport), { columns } = useWindowSize()
  const width = Math.max(1, Math.floor(metrics.clientWidth || columns)), height = Math.max(1, Math.floor(metrics.clientHeight))
  const lines = displayValue(props.result, props.maxTextBytes, props.secrets).split('\n').flatMap(line => {
    const wrapped: string[] = []; let content = '', cells = 0
    for (const part of graphemes(line)) {
      const size = stringWidth(part)
      if (cells + size > width && content.length > 0) { wrapped.push(content); content = ''; cells = 0 }
      content += part; cells += size
    }
    wrapped.push(content); return wrapped
  })
  const last = Math.floor((lines.length - 1) / height) * height, first = Math.min(Math.floor(offset / height) * height, last)
  useEffect(() => { setOffset(0) }, [props.resetKey ?? props.result])
  useInput((_input, key) => {
    if (key.pageDown) setOffset(current => Math.min(last, Math.floor(Math.min(current, last) / height) * height + height))
    else if (key.pageUp) setOffset(current => Math.max(0, Math.floor(Math.min(current, last) / height) * height - height))
  })
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={2}><Text bold wrap="truncate">{props.label ?? '动作/结果'} · {first + 1}–{Math.min(lines.length, first + height)}/{lines.length} 行 · PgUp/PgDn 滚动</Text>
    <Box ref={viewport} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={1} overflowY="hidden"><Text wrap="truncate">{lines.slice(first, first + height).join('\n')}</Text></Box></Box>
}

/** @param props Exact commands and result locations. @returns Copyable argv/PowerShell cards for another terminal. */
export function CommandCardsPanel(props: { readonly cards: readonly CommandCard[]; readonly maxTextBytes: number; readonly offset?: number; readonly rows?: number; readonly secrets?: readonly string[] }) {
  const lines = props.cards.flatMap(card => [plainText(card.label, props.secrets) + ' · 结果/配置位置 ' + plainText(card.location, props.secrets),
    ...displayValue(card.argv, props.maxTextBytes, props.secrets).split('\n'), plainText(powershellCommand(card.argv), props.secrets)])
  const offset = props.offset ?? 0
  return <Box flexDirection="column"><Text bold>另一终端执行的原命令</Text>
    <Text>{lines.slice(offset, props.rows === undefined ? undefined : offset + props.rows).join('\n')}</Text>
    {props.cards.length === 0 && <Text>先建立或登记对应配置；c 创建，l 登记，Enter 编辑</Text>}
    <Text dimColor>卡片只显示命令；实验及 Automation 服务由另一终端拥有</Text></Box>
}

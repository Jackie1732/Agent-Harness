/** The operation desk owns navigation, drafts and display facts; business state stays in OperatorSession. */
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useInput, useWindowSize } from 'ink'
import type { EffectOwner } from '../effect/owner.js'
import type { EffectLease } from '../effect/types.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { AgentObservation, ControlMethod, HostStatusResult, Params, RootObservation, SessionEventPage } from '../protocol/index.js'
import { PARAMS_SCHEMAS } from '../protocol/params-schemas.js'
import type { OperatorResult, OperatorSession, OperatorSubmit } from '../operator/types.js'
import { followOperatorEvents } from '../operator/observations.js'
import type { OperatorFollowSummary } from '../operator/observations.js'
import { readConfigDocument } from '../operator/config-operations.js'
import { decodeHostConfig } from '../host/config.js'
import { configFailure } from '../operator/config-readiness.js'
import { ConfigurationPage } from './configuration.js'
import { CollaborationPanel, ObservationEvidence, OverviewPanel, ResultPanel, TasksPanel } from './panels.js'
import { useOperatorObservation } from './observation.js'
import { TreeEditor } from './tree.js'
import { Picker } from './picker.js'
import { TaskComposer } from './task.js'
import { cancellationMethod, requestDraft, requestParams } from './params.js'
import { displayValue, plainText } from './text.js'
import { appendEventPage, EMPTY_EVENT_BUFFER } from './event-buffer.js'

type Page = 'overview' | 'tasks' | 'collaboration' | 'configuration' | 'events'
type Modal = { readonly kind: 'picker'; readonly title: string; readonly items: readonly { readonly label: string; readonly value: () => void }[] }
  | { readonly kind: 'request'; readonly method: ControlMethod; readonly value: JsonValue; readonly follow?: boolean }
  | { readonly kind: 'task'; readonly input: Omit<OperatorSubmit, 'text' | 'drive'>; readonly question?: string }
  | { readonly kind: 'confirm'; readonly title: string; readonly detail: unknown; readonly run: () => void }

const collaborationMethods: readonly ControlMethod[] = ['message.send', 'message.reply', 'message.get', 'message.wait', 'delegation.spawn', 'delegation.get', 'delegation.wait', 'delegation.cancel',
  'workflow.get', 'workflow.wait', 'workflow.pause', 'workflow.resume', 'workflow.cancel', 'workflow.retry', 'workflow.output', 'workflow.artifact']

export interface TuiAppProps {
  readonly session: OperatorSession; readonly owner: EffectOwner; readonly signal: AbortSignal
  readonly secrets: readonly string[]; readonly environment: Readonly<Record<string, string | undefined>>
  readonly onClose: (mode?: 'drain' | 'cancel', exitCode?: number) => void
  readonly onConfigurationWork: (task: Promise<unknown>) => void
}

/**
 * Present existing operations with exact targets and independent observation evidence.
 * @param props Current session owner and the terminal's resource owner.
 * @returns The complete local/remote operation desk.
 */
export function TuiApp(props: TuiAppProps) {
  const { session, owner, signal } = props, profile = session.profile, { columns, rows } = useWindowSize()
  const [page, setPage] = useState<Page>('overview'), [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [configuredAgents, setConfiguredAgents] = useState<readonly string[]>([]), [workflows, setWorkflows] = useState<readonly string[]>([])
  const [workflowAddresses, setWorkflowAddresses] = useState<Readonly<Record<string, string>>>({})
  const [selectedMethod, setSelectedMethod] = useState(0), [modal, setModal] = useState<Modal | null>(null)
  const [lastResult, setLastResult] = useState<unknown>(null), [configurationEditing, setConfigurationEditing] = useState(false)
  const [requestError, setRequestError] = useState<{ readonly request: Modal; readonly message: string } | null>(null)
  const [selectedRoot, setSelectedRoot] = useState<Params<'root.get'> | null>(null), [pending, setPending] = useState<readonly string[]>([])
  const [events, setEvents] = useState(EMPTY_EVENT_BUFFER), [following, setFollowing] = useState(false)
  const [eventLast, setEventLast] = useState<OperatorResult | null>(null), [eventSummary, setEventSummary] = useState<OperatorFollowSummary | null>(null)
  const [eventFailure, setEventFailure] = useState<unknown>(null)
  const [eventRetired, setEventRetired] = useState(false)
  const eventLease = useRef<Promise<EffectLease<unknown>> | null>(null), eventAbort = useRef<AbortController | null>(null)
  const eventStopping = useRef<Promise<void> | null>(null), eventGeneration = useRef(0)
  const onFailure = useCallback(() => props.onClose(undefined, 1), [props.onClose])
  const status = useOperatorObservation(session, owner, signal, 'host.status', {}, onFailure)
  const agent = useOperatorObservation(session, owner, signal, 'agent.get', selectedAgent === null ? null : { agentKey: selectedAgent }, onFailure)
  const rootObservation = useOperatorObservation(session, owner, signal, 'root.get', selectedRoot, onFailure)
  const host = status.last?.result as HostStatusResult | undefined, observedMember = agent.last?.result as AgentObservation | undefined
  const member = observedMember?.agentKey === selectedAgent ? observedMember : undefined
  const observedRoot = rootObservation.last?.result as RootObservation | undefined
  const root = observedRoot?.agentKey === selectedAgent && observedRoot.rootId === selectedRoot?.rootId ? observedRoot : null
  const agents = configuredAgents.length > 0 ? configuredAgents : host?.report.members.map(item => item.agentKey) ?? []
  useEffect(() => {
    let active = true
    if (profile.connection.kind === 'remote') {
      setConfiguredAgents(profile.connection.targets.agentKeys); setWorkflows(profile.connection.targets.workflowKeys)
      return
    }
    void readConfigDocument(profile.profilePath, 'host').then(document => {
      if (!active) return
      const config = decodeHostConfig(document.value, dirname(document.path))
      setConfiguredAgents(config.members.filter(item => item.kind === 'local').map(item => item.agentKey))
      setWorkflows(config.schemaVersion === 3 && config.workflows.kind === 'enabled' ? config.workflows.definitions.map(item => String(item.definition.workflowKey)) : [])
      setWorkflowAddresses(config.schemaVersion === 3 && config.workflows.kind === 'enabled' ? Object.fromEntries(config.workflows.definitions.map(item => [String(item.definition.workflowKey), String(item.definition.coordinator)])) : {})
    }).catch(cause => { if (active) setLastResult(configFailure(cause)) })
    return () => { active = false }
  }, [profile])
  useEffect(() => { if (selectedAgent === null && agents[0] !== undefined) setSelectedAgent(agents[0]) }, [agents, selectedAgent])
  const reportResult = (result: unknown) => { if (!signal.aborted) setLastResult(result) }
  const execute = (method: ControlMethod, params: Params<ControlMethod>, acknowledgeIntent?: string) => {
    setModal(null); setPending(current => [...current, method])
    const call = () => session.execute(method, params, acknowledgeIntent === undefined ? {} : { acknowledgeIntent })
    const stopped = method === 'session.events' ? stopEvents() : null, generation = eventGeneration.current
    const currentEvent = () => !signal.aborted && eventGeneration.current === generation
    void (stopped === null ? call() : stopped.then(() => { if (!currentEvent()) return null; setEventLast(null); setEventSummary(null); setEventFailure(null); return call() })).then(result => {
      if (result === null || method === 'session.events' && !currentEvent()) return
      reportResult(result)
      if (method === 'session.events') {
        setPage('events')
        if (result.status === 'ok') { setEventRetired(false); setEventLast(result); setEvents(current => appendEventPage(current, result.result as SessionEventPage, profile.observation)) }
        else setEventFailure(result.error ?? result)
      }
      if (method === 'root.get' && result.status === 'ok') {
        const read = result.result as RootObservation; setSelectedRoot({ agentKey: read.agentKey, rootId: read.rootId })
      }
    }).catch(cause => { if (method !== 'session.events' || currentEvent()) reportResult(configFailure(cause)) }).finally(() => setPending(current => { const index = current.indexOf(method); return current.filter((_item, position) => position !== index) }))
  }
  const known = (): JsonObject => ({ ...(selectedAgent === null ? {} : { agentKey: selectedAgent, parentAgentKey: selectedAgent }),
    ...(host === undefined ? {} : { expectedInstanceId: host.instanceId }), ...(root === null ? {} : { rootId: root.rootId, parentRoot: root.rootId }),
    ...(workflows[0] ===undefined ? {} : { workflowKey: workflows[0] }), requestKey: randomUUID(), submissionKey: randomUUID(),
    timeoutMs: profile.observation.maxWaitMs, maxEvents: profile.observation.maxPageEvents })
  const openRequest = (method: ControlMethod, follow = false) => setModal({ kind: 'request', method, value: requestDraft(method, known()), ...(follow ? { follow: true } : {}) })
  const confirmRun = (run: (acknowledgeIntent?: string) => void) => {
    const unknown = [...session.intents()].reverse().find(intent => intent.method === 'host.run' && (intent.outcome === null || intent.outcome.acceptance === 'unknown'))
    if (unknown === undefined) run()
    else setModal({ kind: 'confirm', title: '明确发起新的有限批次；旧 run 仍为 unknown', detail: { intentId: unknown.id, scope: unknown.scope }, run: () => run(unknown.id) })
  }
  const selectRoot = () => setModal({ kind: 'picker', title: '选择当前报告的精确 Root', items: (member?.report.roots ?? []).map(item => ({ label: `${item.id} · ${item.source.kind} · ${item.outcome ?? '未结算'}`,
    value: () => execute('root.get', { agentKey: selectedAgent!, rootId: item.id }) })) })
  const answer = () => {
    if (selectedAgent === null || root === null || root.agentKey !== selectedAgent) { selectRoot(); return }
    const agentKey = selectedAgent, rootId = root.rootId
    setModal({ kind: 'picker', title: '正在核验精确 Root 的当前 user wait', items: [] })
    void session.execute('root.get', { agentKey, rootId }).then(result => {
      reportResult(result)
      if (signal.aborted) return
      if (result.status !== 'ok') { setModal(null); return }
      const fresh = result.result as RootObservation
      setModal({ kind: 'picker', title: `仅回答新核验的精确 user wait · ${result.receivedAt ?? 'cut见结果'}`, items: fresh.waits.flatMap(wait => wait.descriptor.kind === 'user' ? [{
        label: `${wait.reference.eventId}:${wait.reference.index} · ${plainText(wait.descriptor.question, props.secrets)}`,
        value: () => setModal({ kind: 'task', input: { agentKey, wait: wait.reference }, question: wait.descriptor.kind === 'user' ? wait.descriptor.question : '' }),
      }] : []) })
    }).catch(cause => { reportResult(configFailure(cause)); setModal(null) })
  }
  const stopEvents = (): Promise<void> => {
    eventGeneration.current++; eventAbort.current?.abort(); setFollowing(false); setEventRetired(true)
    if (eventStopping.current !== null) return eventStopping.current
    const previous = eventLease.current
    if (previous === null) return Promise.resolve()
    const stopping: Promise<void> = previous.then(lease => lease.dispose()).finally(() => {
      if (eventLease.current === previous) { eventLease.current = null; eventAbort.current = null }
      if (eventStopping.current === stopping) eventStopping.current = null
    })
    eventStopping.current = stopping; return stopping
  }
  const startEvents = (params: Params<'session.events'>) => {
    setModal(null); setPage('events')
    const stopped = stopEvents(), generation = eventGeneration.current, current = () => !signal.aborted && eventGeneration.current === generation
    void (async () => {
      await stopped
      if (!current()) return
      const abort = new AbortController(); eventAbort.current = abort; setFollowing(true); setEventRetired(false); setEventLast(null); setEventSummary(null); setEventFailure(null)
      const lease = owner.run('tui-events', context => context.apply('event-observer', () => {
        const task = followOperatorEvents(session, params, async (result: OperatorResult) => {
          if (!current()) throw new Error('event-observer-retired')
          setEventLast(result); setEvents(buffer => appendEventPage(buffer, result.result as SessionEventPage, profile.observation))
        }, { signal: AbortSignal.any([signal, abort.signal]) }).then(summary => { if (current()) { setEventSummary(summary); reportResult(summary) } })
        return { task, abort }
      }, async value => { value.abort.abort(); await value.task }))
      eventLease.current = lease
      await lease.then(value => value.value.task); if (current()) setFollowing(false)
    })().catch(cause => { if (current()) { const failure = configFailure(cause); setEventFailure(failure); reportResult(failure); setFollowing(false) } })
  }
  const changeAgent = (direction: number) => {
    const index = Math.max(0, agents.indexOf(selectedAgent ?? '')), next = agents[Math.max(0, Math.min(agents.length - 1, index + direction))]
    if (next !== undefined && next !== selectedAgent) { void stopEvents().catch(onFailure); setSelectedAgent(next); setSelectedRoot(null) }
  }
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { props.onClose(undefined, 130); return }
    if (modal !== null || configurationEditing) return
    if (key.escape) { void stopEvents().catch(onFailure); return }
    if (input === 'q') {
      setModal({ kind: 'picker', title: profile.connection.kind === 'local' ? '关闭本端拥有的 Host' : '关闭本端；服务器继续运行', items: profile.connection.kind === 'local'
        ? [{ label: 'drain：加入已接纳工作后退出', value: () => props.onClose('drain') }, { label: 'cancel：请求停止并等待释放', value: () => props.onClose('cancel') }]
        : [{ label: '关闭 Client 与本端记录', value: () => props.onClose() }] }); return
    }
    const navigation: Readonly<Record<string, Page>> = { '1': 'overview', '2': 'tasks', '3': 'collaboration', '4': 'configuration', '5': 'events' }
    if (navigation[input] !== undefined) { void stopEvents().catch(onFailure); setPage(navigation[input]); return }
    if (page === 'configuration') return
    if (input === 'j') { setModal({ kind: 'picker', title: '本端持久操作；旧 unknown 保留', items: session.intents().map(intent => ({ label: `${intent.id} · ${intent.method} · ${intent.outcome?.acceptance ?? 'unknown'}`,
      value: () => { setModal(null); reportResult(intent) } })) }); return }
    if (input === 'u') { setModal({ kind: 'picker', title: '明确恢复原 keyed task/answer（不运行）', items: session.intents().filter(intent => intent.method === 'input.submit' || intent.method === 'input.answer').map(intent => ({
      label: `${intent.id} · ${intent.method}`, value: () => { setModal(null); void session.resume(intent.id).then(reportResult).catch(cause => reportResult(configFailure(cause))) } })) }); return }
    if (input === 'b') { confirmRun(acknowledge => execute('host.run', { expectedInstanceId: host?.instanceId ?? '' }, acknowledge)); return }
    if (input === 's') { openRequest('host.shutdown'); return }
    if (page === 'collaboration') {
      if (key.upArrow) setSelectedMethod(current => Math.max(0, current - 1))
      else if (key.downArrow) setSelectedMethod(current => Math.min(collaborationMethods.length - 1, current + 1))
      else if (key.return) openRequest(collaborationMethods[selectedMethod]!)
      return
    }
    if (key.upArrow) changeAgent(-1)
    else if (key.downArrow) changeAgent(1)
    else if (input === 'n' && selectedAgent !== null) setModal({ kind: 'task', input: { agentKey: selectedAgent } })
    else if (input === 'a') answer()
    else if (input === 'r') selectRoot()
    else if (input === 'x' && root !== null) {
      if (root.source.kind === 'ordinary') openRequest('root.cancel')
      else {
        const coordinator = root.source.assignment.address, workflowKey = Object.entries(workflowAddresses).find(([, address]) => address === coordinator)?.[0] ?? ''
        setModal({ kind: 'request', method: 'workflow.cancel', value: requestDraft('workflow.cancel', { ...known(), workflowKey }) })
      }
    }
    else if (input === 'w') openRequest('root.wait')
    else if (input === 'g') openRequest('input.get')
    else if (input === 'p' && selectedAgent !== null) execute(member?.paused ? 'agent.resume' : 'agent.pause', { agentKey: selectedAgent, expectedInstanceId: host?.instanceId ?? '' })
    else if (input === 'e') setModal({ kind: 'picker', title: '明确事件观察方式', items: [{ label: '单页；固定 cut 可继续翻页', value: () => openRequest('session.events') },
      { label: '跟随；Esc 停止观察', value: () => openRequest('session.events', true) }] })
  })
  const submitTask = (input: Omit<OperatorSubmit, 'text' | 'drive'>, text: string, drive: boolean) => {
    const run = (acknowledgeIntent?: string) => { setModal(null); void session.submit({ ...input, text, drive, ...(acknowledgeIntent === undefined ? {} : { acknowledgeIntent }) })
      .then(reportResult).catch(cause => reportResult(configFailure(cause))) }
    if (drive) confirmRun(run); else run()
  }
  const methodRows = Math.max(1, rows - 12), firstMethod = Math.max(0, selectedMethod - methodRows + 1)
  const show = modal?.kind === 'picker' ? <Picker title={modal.title} items={modal.items} onSelect={callback => callback()} onCancel={() => setModal(null)} />
    : modal?.kind === 'task' ? <TaskComposer agentKey={modal.input.agentKey} {...(modal.input.wait === undefined ? {} : { wait: modal.input.wait })}
      {...(modal.question === undefined ? {} : { question: modal.question })} secrets={props.secrets} onSubmit={(text, drive) => submitTask(modal.input, text, drive)} onCancel={() => setModal(null)} />
    : modal?.kind === 'request' ? <Box flexDirection="column">{requestError?.request === modal && <Text color="red">{requestError.message}</Text>}
      <TreeEditor title={`${modal.method} · 原协议完整参数${modal.follow ? ' · 跟随' : ''}`} initial={modal.value} schema={PARAMS_SCHEMAS[modal.method]}
      maxTextBytes={profile.display.maxTextBytes} secrets={props.secrets} submitLabel="采用参数" onCancel={() => setModal(null)} onSubmit={candidate => {
        try {
          const params = requestParams(modal.method, candidate), run = () => modal.follow && modal.method === 'session.events' ? startEvents(params as Params<'session.events'>) : execute(modal.method, params)
          if (cancellationMethod(modal.method)) setModal({ kind: 'confirm', title: `确认精确 ${modal.method} 目标`, detail: params, run })
          else run()
        } catch { const message = '参数未通过原协议校验；检查完整字段、引用和预算。Esc 继续编辑'; setRequestError({ request: modal, message }); reportResult({ code: 'API_PROTOCOL_INVALID', message }) }
      }} /></Box>
    : modal?.kind === 'confirm' ? <Box flexDirection="column"><Text>{displayValue(modal.detail, profile.display.maxTextBytes, props.secrets)}</Text><Picker title={modal.title}
      items={[{ label: '明确采用', value: true }, { label: '返回', value: false }]} onCancel={() => setModal(null)} onSelect={yes => { if (yes) modal.run(); else setModal(null) }} /></Box>
    : page === 'overview' ? <OverviewPanel session={session} observation={status} selectedAgent={selectedAgent} secrets={props.secrets} />
    : page === 'tasks' ? <TasksPanel observation={agent} root={root} rootObservation={rootObservation} maxTextBytes={profile.display.maxTextBytes} secrets={props.secrets} />
    : page === 'collaboration' ? <CollaborationPanel methods={collaborationMethods.slice(firstMethod, firstMethod + methodRows)} selected={selectedMethod - firstMethod} agentKey={selectedAgent} remote={profile.connection.kind === 'remote'} />
    : page === 'configuration' ? <ConfigurationPage profile={profile} secrets={props.secrets} environment={props.environment} onEditing={setConfigurationEditing} onResult={reportResult} onWork={props.onConfigurationWork} />
    : <Box flexDirection="column" flexGrow={1}><Text bold>事件 · {events.sessionId ?? '先用 e 选择目标'} · 固定cut {events.through} · {following ? '观察中' : eventSummary === null && !eventRetired ? '单页' : '已停止'}</Text>
      <Text color="yellow">本端保留 {events.events.length} 项 · 省略历史 {events.omitted} 项</Text>
      <ObservationEvidence observation={{ last: eventLast, stale: eventRetired || eventLast === null || eventSummary !== null || eventFailure !== null, error: null }} secrets={props.secrets} />
      {eventSummary !== null && <Text color={eventSummary.stoppedBy === 'read-failure' || eventSummary.stoppedBy === 'output-failure' ? 'red' : 'yellow'}>
        跟随停止 · {eventSummary.stoppedBy} · {eventSummary.stoppedBy === 'read-failure' ? '读取或 checkpoint 失败；保留旧页面' : eventSummary.stoppedBy === 'output-failure' ? '页面显示失败；保留旧页面' : '观察已停止；保留旧页面'} · 已消费 {eventSummary.pages} 页/{eventSummary.events} 项
      </Text>}
      {eventFailure !== null && <Text color="red">{displayValue(eventFailure, profile.display.maxTextBytes, props.secrets)}</Text>}
      <ResultPanel label="事件内容" result={events.events} resetKey={events.sessionId} maxTextBytes={profile.display.maxTextBytes} secrets={props.secrets} /></Box>
  return <Box flexDirection="column" height={Math.max(8, rows)} width={columns}>
    <Text bold color="green">Atomic Harness · 1概览 2任务 3协作 4配置 5事件 · {profile.connection.kind} · {page}</Text>
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">{show}</Box>
    {modal === null && page !== 'configuration' && page !== 'events' && lastResult !== null && <Box flexDirection="column" height={Math.max(3, Math.floor(rows / 4))} overflowY="hidden">
      <ResultPanel result={lastResult} maxTextBytes={profile.display.maxTextBytes} secrets={props.secrets} /></Box>}
    <Text dimColor wrap="truncate">{pending.length > 0 ? `调用中 ${pending.join(', ')} · ` : ''}j 操作记录 · u 原输入恢复 · b 有限run · s 显式host stop · q 退出 · Ctrl+C 统一关闭</Text>
  </Box>
}

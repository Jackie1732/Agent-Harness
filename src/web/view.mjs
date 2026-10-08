export const el = (name, text, className) => { const node = document.createElement(name); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node }
export const clear = id => { const node = document.getElementById(id); node.replaceChildren(); return node }
export function details(value) { const node = el('details'); node.append(el('summary','完整事实与来源'), el('pre',JSON.stringify(value,null,2))); return node }
const badge = (text, warning = false) => el('span', text, `badge${warning ? ' warning' : ''}`)
export function selectRoot(rootId) {
  const form = document.getElementById('root-form'), select = document.getElementById('root-select')
  form.elements.rootId.value = rootId; document.getElementById('child-spawn-form').elements.parentRoot.value = rootId
  select.value = [...select.options].some(option => option.value === rootId) ? rootId : ''
}
export function renderInputIntent(input, acceptance) {
  const form = document.getElementById('input-form'), parent = clear('input-result')
  form.elements.lookup.value = 'key'; form.elements.value.value = input.submissionKey
  parent.append(el('p', `本次输入身份：${input.agentKey} · ${input.submissionKey}`, 'hint'),
    badge(acceptance === 'pending' ? '提交中：尚未取得接纳回执' : `接纳效力：${acceptance}`, acceptance !== 'not-accepted'),
    details({ agentKey: input.agentKey, submissionKey: input.submissionKey, acceptance }))
}
export function factBadges(value) {
  const node = el('div')
  if (value.recoveryRequired !== undefined) node.append(badge(value.recoveryRequired ? '需要恢复' : '恢复：无需', value.recoveryRequired))
  if (value.outcome !== undefined) node.append(badge(`业务：${value.outcome ?? '未结算'}`, ['result-unknown','failed'].includes(value.outcome)))
  if (value.settled !== undefined) node.append(badge(`业务结算：${value.settled ? '是' : '否'}`))
  if (value.closed !== undefined) node.append(badge(`资源与协议关闭：${value.closed ? '是' : '否'}`, !value.closed))
  if (value.executionPending !== undefined) node.append(badge(`执行资源：${value.executionPending ? '待释放' : '无待释放'}`, value.executionPending))
  if (value.businessResolved !== undefined) node.append(badge(`业务结算：${value.businessResolved ? '是' : '否'}`))
  if (value.executionReleased !== undefined) node.append(badge(`执行释放：${value.executionReleased ? '是' : '否'}`, !value.executionReleased))
  if (value.cleanupIncomplete) node.append(badge('清理未完成', true))
  if (value.failureCode) node.append(badge(value.failureCode, true))
  return node
}
export function renderHost(status) {
  const parent = clear('status-cards')
  for (const [label, value] of [['Host',status.hostStatus],['活动',status.activity],['待处理输入',status.report.counts.pendingInputs],['待回答',status.report.counts.pendingWaits]]) {
    const card = el('div',undefined,'card'); card.append(el('span',label),el('strong',value)); parent.append(card)
  }
}
export function renderAgent(agent) {
  const parent = clear('agent-result'); parent.append(badge(`调度：${agent.readiness.blockedBy}`, !agent.readiness.canRun),badge(agent.paused ? 'Agent 已暂停' : 'Agent 未暂停'),factBadges(agent))
  if (agent.report.final !== null) parent.append(el('div',agent.report.final.text ?? `文本已省略（${agent.report.final.textBytes} 字节）`,'output'))
  parent.append(details(agent))
  const select = document.getElementById('root-select'); select.replaceChildren(el('option','选择 Root'))
  select.firstChild.value = ''
  for (const root of agent.report.roots) { const option = el('option',`${root.outcome ?? '未结算'} · ${root.id}`); option.value = root.id; select.append(option) }
  selectRoot(document.getElementById('root-form').elements.rootId.value)
  if (agent.report.truncated.roots) parent.append(el('p','Root 列表已截断，可直接输入精确 Root 身份查询。','hint'))
}
export function renderRoot(result, answer) {
  const parent = clear('root-result'), root = result.observation ?? result
  if (result.observation !== undefined) parent.append(badge(`等待结果：${result.status}`, result.status !== 'condition-met'))
  parent.append(factBadges(root))
  if (root.final !== null) parent.append(el('div', root.final.text ?? `终态文本已省略（${root.final.textBytes} 字节）`, 'output'))
  for (const wait of root.waits) {
    const item = el('div',undefined,'wait'); item.append(badge(`等待：${wait.descriptor.kind}`))
    if (wait.descriptor.kind === 'user') {
      item.append(el('p',wait.descriptor.question))
      const form = el('form'), keyLabel = el('label','回答提交键'), key = el('input'), textLabel = el('label','回答'), text = el('textarea'), button = el('button','接纳这个精确等待的回答')
      key.name = 'submissionKey'; key.required = true; text.name = 'text'; text.required = true; text.rows = 3; keyLabel.append(key); textLabel.append(text); form.append(keyLabel,textLabel,button)
      form.addEventListener('submit',event => { event.preventDefault(); answer(root.agentKey,wait.reference,form) }); item.append(form)
    }
    item.append(details(wait)); parent.append(item)
  }
  parent.append(details(root))
}
export function renderObservation(id, result) {
  const parent = clear(id), value = result.observation ?? result
  if (result.observation !== undefined) parent.append(badge(`等待结果：${result.status}`,result.status !== 'condition-met'))
  parent.append(factBadges(value),details(value))
}
export function renderWorkflow(result, output, artifact) {
  const parent = clear('workflow-result'), workflow = result.observation ?? result
  if (result.observation !== undefined) parent.append(badge(`等待结果：${result.status}`, result.status !== 'condition-met'))
  parent.append(badge(`状态：${workflow.state}`),factBadges(workflow))
  for (const node of workflow.nodes) {
    const row = el('div',undefined,'actions'); row.append(badge(`${node.nodeKey} · ${node.status}`))
    const button = el('button','读取已接受输出','quiet'); button.addEventListener('click',() => output(node.nodeKey)); row.append(button); parent.append(row)
  }
  for (const item of workflow.artifacts) {
    const row = el('div',undefined,'actions'), button = el('button',`读取产物 ${item.name}`,'quiet'); button.addEventListener('click',() => artifact(item.ref))
    row.append(button,el('span',`${item.byteLength} 字节 · ${item.sha256}`,'hint')); parent.append(row)
  }
  if (workflow.truncated) parent.append(el('p','此报告已按预算截断；完整来源可用固定前缀事件页检查。','hint'))
  parent.append(details(workflow))
}
export function renderArtifact(result) {
  const parent = clear('artifact-result')
  if ('status' in result && result.status === 'not-available') parent.append(el('p','此节点尚无已接受输出。','hint'))
  else parent.append(el('div', result.text ?? (typeof result.value === 'string' ? result.value : JSON.stringify(result.value,null,2)), 'output'))
  parent.append(details(result))
}
export function renderEvents(page, filter = 'all') {
  const parent = clear('events-result'); parent.append(el('p',`Session ${page.sessionId} · 固定前缀 through=${page.through} · ${page.events.length} 项 · ${page.hasMore ? '还有下一页' : '已到该前缀末尾'}`,'hint'))
  for (const event of page.events) {
    if (filter !== 'all' && !event.type.startsWith(`${filter}/`)) continue
    const item = el('div',undefined,'event'); item.append(el('b',`#${event.sequence} ${event.type}`),el('span',` · ${event.eventId}`),details(event)); parent.append(item)
  }
}
export function renderReceipt(method,result) { const parent = clear('operation-result'); parent.append(badge(method),factBadges(result),details(result)) }
export function notice(error) {
  const parent = document.getElementById('notice'); parent.hidden = false
  parent.textContent = `${error.code ?? '输入需要修订'}${error.domainCode ? ` / ${error.domainCode}` : ''}\n${error.message}${error.acceptance ? `\n接纳效力：${error.acceptance}${error.acceptance === 'unknown' ? '。先查询原提交键或精确业务身份，不自动重发。' : ''}` : ''}`
}

import { browserRequest, control, abortRequests } from './rpc.mjs'
import { fields, formRequest } from './forms.mjs'
import { el, clear, details, selectRoot, renderHost, renderAgent, renderRoot, renderObservation, renderWorkflow, renderArtifact, renderEvents, renderReceipt, notice } from './view.mjs'

let instanceId, page, eventQuery, busy = false
const element = id => document.getElementById(id)
const agentKey = () => element('member-select').value
const workflowKey = () => element('workflow-select').value
function showLogin() { element('workspace').hidden = true; element('session-tools').hidden = true; element('login-view').hidden = false; instanceId = undefined; page = undefined; eventQuery = undefined }
function working(value) {
  busy = value; element('busy-label').textContent = value ? '正在取得本次操作回执…' : ''
  for (const button of document.querySelectorAll('#workspace button')) button.disabled = value
  element('member-select').disabled = value; element('workflow-select').disabled = value
  element('stop-observation').disabled = !value
  element('events-next').disabled = value || page?.nextCursor == null
}
async function perform(work) {
  if (busy) return
  working(true); element('notice').hidden = true
  try { return await work() }
  catch (error) { notice(error); if (error.code === 'UI_UNAUTHORIZED') showLogin() }
  finally { working(false) }
}
async function connection() {
  const session = await browserRequest('/api/session')
  element('connection').textContent = session.connection.origin
  for (const [id, values] of [['member-select',session.connection.memberKeys],['workflow-select',session.connection.workflowKeys]]) {
    const select = element(id); select.replaceChildren()
    for (const value of values) { const option = el('option',value); option.value = value; select.append(option) }
  }
  element('login-view').hidden = true; element('workspace').hidden = false; element('session-tools').hidden = false
  await refresh()
}
async function refresh() {
  try { const status = await control('host.status',{}); instanceId = status.instanceId; renderHost(status) }
  catch (error) { if (error.code !== 'API_FORBIDDEN') throw error; clear('status-cards').append(el('p','当前证书没有 Host 总览权限，仍可操作已授权成员。','hint')) }
  if (agentKey()) { const agent = await control('agent.get',{agentKey:agentKey()}); instanceId = agent.instanceId; renderAgent(agent) }
}
function answer(member, reference, form) {
  void perform(async () => { const value = fields(form), params = {agentKey:member,wait:reference,submissionKey:value.submissionKey,text:value.text}; display('input.answer',await control('input.answer',params),params) })
}
function display(method,result,params) {
  renderReceipt(method,result)
  if (result.instanceId) instanceId = result.instanceId
  if (method === 'input.submit' || method === 'input.answer') {
    element('input-form').elements.lookup.value = 'key'; element('input-form').elements.value.value = params.submissionKey
    clear('input-result').append(el('p',`已接纳输入 ${result.inputEventId}${result.reused ? '（复用）' : ''}；显式运行推进任务。`,'hint'),details(result))
  }
  if (method === 'input.get') { renderObservation('input-result',result); selectRoot(result.rootId ?? ''); clear('root-result') }
  if (method.startsWith('root.')) {
    const root = result.observation ?? result
    selectRoot(root.rootId)
    if ('waits' in root) renderRoot(root,answer); else renderObservation('root-result',result)
  }
  if (method.startsWith('message.')) {
    renderObservation('message-result',result)
    if (result.messageId) element('message-query-form').elements.messageId.value = result.messageId
  }
  if (method.startsWith('delegation.')) {
    renderObservation('child-result',result)
    if (method === 'delegation.spawn') { element('child-form').elements.delegationId.value = result.delegationId; element('child-form').elements.parentRoot.value = params.parentRoot }
  }
  if (method === 'workflow.get' || method === 'workflow.wait') {
    const workflow = result.observation ?? result
    renderWorkflow(workflow, nodeKey => void perform(async () => renderArtifact(await control('workflow.output',{workflowKey:workflow.workflowKey,nodeKey}))),
      artifactRef => void perform(async () => renderArtifact(await control('workflow.artifact',{workflowKey:workflow.workflowKey,artifactRef}))))
  }
  if (method === 'workflow.output' || method === 'workflow.artifact') renderArtifact(result)
  if (method === 'session.events') { page = result; renderEvents(page,element('event-filter').value) }
}
element('login-form').addEventListener('submit',event => { event.preventDefault(); void perform(async () => { const form = element('login-form'); await browserRequest('/api/login',fields(form)); form.reset(); await connection() }) })
element('logout').addEventListener('click',() => void perform(async () => { await browserRequest('/api/logout',{}); showLogin() }))
element('stop-observation').addEventListener('click',abortRequests)
element('refresh').addEventListener('click',() => void perform(refresh))
element('member-select').addEventListener('change',() => {
  page = undefined; eventQuery = undefined; element('root-form').elements.rootId.value = ''; element('root-select').value = ''
  element('child-spawn-form').elements.parentRoot.value = ''; element('child-form').elements.parentRoot.value = ''; element('child-form').elements.delegationId.value = ''
  clear('root-result'); clear('child-result'); clear('events-result'); void perform(refresh)
})
element('workflow-select').addEventListener('change',() => { page = undefined; eventQuery = undefined; clear('workflow-result'); clear('artifact-result'); clear('events-result'); element('events-next').disabled = true })
element('root-select').addEventListener('change',() => { selectRoot(element('root-select').value); clear('root-result') })
element('root-form').elements.rootId.addEventListener('input',() => { selectRoot(element('root-form').elements.rootId.value); clear('root-result') })
for (const operation of ['run','pause','resume']) element(operation).addEventListener('click',() => void perform(async () => {
  if (!instanceId) throw new Error('请先刷新当前 Host 或成员状态。')
  const method = operation === 'run' ? 'host.run' : `agent.${operation}`, params = operation === 'run' ? { expectedInstanceId:instanceId } : { agentKey:agentKey(),expectedInstanceId:instanceId }
  display(method,await control(method,params)); await refresh()
}))
for (const button of document.querySelectorAll('nav button')) button.addEventListener('click',() => {
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `${button.dataset.view}-view`
  for (const tab of document.querySelectorAll('nav button')) if (tab === button) tab.setAttribute('aria-current','page'); else tab.removeAttribute('aria-current')
})
for (const form of document.querySelectorAll('#workspace form')) form.addEventListener('submit',event => {
  event.preventDefault(); const operation = event.submitter?.value || 'get'
  const value = fields(form), context = {agentKey:agentKey(),workflowKey:workflowKey(),rootId:element('root-form').elements.rootId.value,
    parentRoot:element('child-form').elements.parentRoot.value,delegationId:element('child-form').elements.delegationId.value,instanceId}
  void perform(async () => {
    const [method,params] = formRequest(form.id,value,operation,context)
    if (method === 'session.events') eventQuery = { target:structuredClone(params.target),maxEvents:params.maxEvents }
    display(method,await control(method,params),params)
  })
})
element('events-next').addEventListener('click',() => void perform(async () => {
  if (page?.nextCursor == null || eventQuery === undefined) return
  display('session.events',await control('session.events',{...eventQuery,cursor:page.nextCursor}))
}))
element('event-filter').addEventListener('change',() => { if (page) renderEvents(page,element('event-filter').value) })
try { await connection() } catch (error) { showLogin(); if (error.code !== 'UI_UNAUTHORIZED') notice(error) }

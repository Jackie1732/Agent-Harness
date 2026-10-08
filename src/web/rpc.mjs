const active = new Set()
const reads = new Set(['host.status','session.events','workflow.output','workflow.artifact'])
export const isRead = method => method.endsWith('.get') || method.endsWith('.wait') || reads.has(method)
export function abortRequests() { for (const controller of active) controller.abort() }
export async function browserRequest(path, body, method) {
  const controller = new AbortController(); active.add(controller)
  try {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal })
    const data = await response.json()
    if (!response.ok || data.kind === 'error') throw Object.assign(new Error(data.error?.message ?? '本地网关没有提供有效回执'), data.error)
    return data
  } catch (error) {
    if (error.code !== undefined) throw error
    throw Object.assign(new Error(error.name === 'AbortError' ? '本地请求已停止；已接纳业务仍由 Host 拥有。' : '没有获得有效回执；查询原提交键或精确业务身份后再决定下一步。'),
      { code: error.name === 'AbortError' ? 'CLIENT_ABORTED' : 'CLIENT_TRANSPORT_ERROR', acceptance: method === undefined || isRead(method) ? 'not-applicable' : 'unknown', domainCode: null })
  } finally { active.delete(controller) }
}
export async function control(method, params) { return (await browserRequest('/api/control', { method, params }, method)).result }

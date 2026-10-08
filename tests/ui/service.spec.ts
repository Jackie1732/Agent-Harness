import { request } from 'node:http'
import { createConnection } from 'node:net'
import { expect, it, vi } from 'vitest'
import { createHarnessClient } from '../../src/client/client.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import * as hostRuntime from '../../src/host/runtime.js'
import { password, uiFixture } from './fixtures.js'

it('closes a pipelined browser connection before a second request can submit work', async () => {
  const fixture = await uiFixture()
  try {
    const url = new URL(fixture.ui.ready.url), body = JSON.stringify({ method: 'input.submit', params: {
      agentKey: 'writer', submissionKey: 'pipelined-task', text: 'Must not be submitted' } })
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: url.hostname, port: Number(url.port) })
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Pipelined connection remained open')) }, 3000)
      socket.on('data', () => undefined); socket.on('error', error => { clearTimeout(timer); reject(error) })
      socket.once('close', () => { clearTimeout(timer); resolve() })
      socket.once('connect', () => socket.write(`GET / HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`
        + `POST /api/control HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${url.origin}\r\nCookie: ${fixture.cookie}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`))
    })
    expect((await fixture.rpc('input.get', { agentKey: 'writer', submissionKey: 'pipelined-task' })).body.error.code).toBe('API_TARGET_NOT_FOUND')
    expect(fixture.service.status).toBe('ready')
  } finally { await fixture.dispose() }
}, 30000)

it('keeps assets public, connection details authenticated and cookie login replaceable', async () => {
  const fixture = await uiFixture()
  try {
    for (const [path, type] of [['/', 'text/html'], ['/style.css', 'text/css'], ['/app.mjs', 'text/javascript']]) {
      const response = await fixture.http(path!)
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain(type)
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      const content = await response.text(); expect(content).not.toContain(password); expect(content).not.toContain('BEGIN PRIVATE KEY')
    }
    expect((await fixture.http('/api/session')).status).toBe(401)
    const session = await (await fixture.http('/api/session', undefined, fixture.cookie)).json()
    expect(session.connection.memberKeys).toEqual(['writer', 'reviewer']); expect(JSON.stringify(session)).not.toContain('caFile')
    expect((await fixture.http('/api/login', { password: 'wrong' })).status).toBe(401)
    expect((await fixture.http('/api/session', undefined, fixture.cookie)).status).toBe(200)
    const relogin = await fixture.http('/api/login', { password }), cookie = relogin.headers.get('set-cookie')!.split(';')[0]!
    expect((await fixture.http('/api/session', undefined, fixture.cookie)).status).toBe(401)
    expect((await fixture.http('/api/logout', {}, cookie)).status).toBe(200)
    expect((await fixture.http('/api/session', undefined, cookie)).status).toBe(401)
    expect((await fixture.http('/../ui/server.ts')).status).toBe(404)
  } finally { await fixture.dispose() }
}, 30000)
it('rejects foreign Origin and Host, unbounded JSON and invalid wire before remote mutation', async () => {
  const fixture = await uiFixture()
  try {
    const hostile = await fetch(`${fixture.ui.ready.url}/api/control`, { method: 'POST', headers: { origin: 'http://attacker.invalid', cookie: fixture.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'host.status', params: {} }) })
    expect(hostile.status).toBe(403)
    const wrongHost = await new Promise<number>(resolve => {
      const call = request(`${fixture.ui.ready.url}/`, { headers: { host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode!) }); call.end()
    })
    expect(wrongHost).toBe(403)
    const overflow = await fetch(`${fixture.ui.ready.url}/api/login`, { method: 'POST', headers: { origin: fixture.ui.ready.url, 'content-type': 'application/json' }, body: 'x'.repeat(fixture.config.limits.maxRequestBytes + 1) })
    expect(overflow.status).toBe(413)
    expect((await fixture.rpc('input.submit', { agentKey: 'writer', submissionKey: 'invalid', text: 'text', originLabel: 'forged' })).status).toBe(400)
    expect((await fixture.rpc('agent.get', { agentKey: 'ungranted' })).body.error).toMatchObject({ code: 'API_FORBIDDEN', acceptance: 'not-applicable' })
    expect((await fixture.rpc('agent.get', { agentKey: 'writer' })).body.result.report.counts.inputs).toBe(0)
  } finally { await fixture.dispose() }
}, 30000)
it('submits and observes durable tasks, exact roots, message receipts and fixed event pages', async () => {
  const fixture = await uiFixture()
  try {
    const status = (await fixture.rpc('host.status', {})).body.result
    const receipt = (await fixture.rpc('input.submit', { agentKey: 'writer', submissionKey: 'ui-task', text: 'Research <script>danger</script>' })).body.result
    expect(receipt.reused).toBe(false)
    expect((await fixture.rpc('input.submit', { agentKey: 'writer', submissionKey: 'ui-task', text: 'Research <script>danger</script>' })).body.result.reused).toBe(true)
    expect((await fixture.rpc('input.submit', { agentKey: 'writer', submissionKey: 'ui-task', text: 'Changed' })).body.error).toMatchObject({ code: 'API_KEY_CONFLICT', acceptance: 'not-accepted' })
    const first = (await fixture.rpc('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 1 })).body.result
    await fixture.rpc('host.run', { expectedInstanceId: status.instanceId })
    const input = (await fixture.rpc('input.get', { agentKey: 'writer', submissionKey: 'ui-task' })).body.result
    const root = (await fixture.rpc('root.get', { agentKey: 'writer', rootId: input.rootId })).body.result
    expect(root.outcome).toBe('completed'); expect(root.final?.text).toBe('writer answer'); expect(root.recoveryRequired).toBe(false)
    const second = (await fixture.rpc('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 1, cursor: first.nextCursor })).body.result
    expect(second.through).toBe(first.through); expect(second.events[0]!.sequence).toBe(2)
    const message = (await fixture.rpc('message.send', { agentKey: 'writer', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"Review"}' })).body.result
    expect(message.status).toBe('outbox-accepted')
    await fixture.rpc('host.run', { expectedInstanceId: status.instanceId })
    expect((await fixture.rpc('message.get', { agentKey: 'writer', messageId: message.messageId, direction: 'outbox' })).body.result.fact.status).toBe('delivered')
  } finally { await fixture.dispose() }
}, 30000)
it('answers the exact persisted human wait and continues it only after explicit run', async () => {
  const fixture = await uiFixture({ question: true })
  try {
    const agent = (await fixture.rpc('agent.get', { agentKey: 'writer' })).body.result, rootId = agent.report.roots[0]!.id
    const root = (await fixture.rpc('root.get', { agentKey: 'writer', rootId })).body.result
    const wait = root.waits[0]!
    expect(wait.descriptor).toMatchObject({ kind: 'user', question: '确认继续研究？' })
    const receipt = (await fixture.rpc('input.answer', { agentKey: 'writer', submissionKey: 'answer', wait: wait.reference, text: '继续' })).body.result
    expect(receipt.inputEventId).toBeDefined()
    expect((await fixture.rpc('root.get', { agentKey: 'writer', rootId })).body.result.outcome).toBeNull()
    await fixture.rpc('host.run', { expectedInstanceId: agent.instanceId })
    expect((await fixture.rpc('root.get', { agentKey: 'writer', rootId })).body.result.outcome).toBe('completed')
  } finally { await fixture.dispose() }
}, 30000)
it('bounds pending calls and closes only local resources while remote accepted work survives', async () => {
  const original = FileSessionBackend.prototype.openWriter
  let entered!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  let submitted!: () => void
  const accepted = new Promise<void>(resolve => { submitted = resolve }), originalHost = hostRuntime.openHost
  vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id) {
    const writer = await original.call(this, id)
    return { ...writer, append: async (position, event) => { if (event.type === 'agent/input-accepted') { entered(); await held } return writer.append(position, event) } }
  })
  vi.spyOn(hostRuntime, 'openHost').mockImplementation(async (...args) => {
    const host = await originalHost(...args), submit = host.submitKeyedInput.bind(host)
    vi.spyOn(host, 'submitKeyedInput').mockImplementation(async (...values) => { const result = await submit(...values); submitted(); return result })
    return host
  })
  const fixture = await uiFixture({ maxPendingRequests: 1 }), observer = createHarnessClient(fixture.options)
  try {
    const operation = fixture.rpc('input.submit', { agentKey: 'writer', submissionKey: 'close-survives', text: 'Accepted remotely' }).catch(error => ({ error }))
    await arrived
    expect((await fixture.http('/')).status).toBe(429)
    const closing = fixture.ui.dispose(); expect(fixture.ui.dispose()).toBe(closing); await closing
    const stopped = await operation; expect('error' in stopped).toBe(true)
    release(); await accepted
    const input = await observer.request('input.get', { agentKey: 'writer', submissionKey: 'close-survives' })
    expect(input.submission?.key).toBe('close-survives')
    expect((await observer.request('host.status', {})).hostStatus).toBe('ready')
  } finally { release(); vi.restoreAllMocks(); await observer.close(); await fixture.dispose() }
}, 30000)

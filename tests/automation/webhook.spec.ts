import { readFile } from 'node:fs/promises'
import { request } from 'node:https'
import { afterEach, describe, expect, it } from 'vitest'
import { openAutomationWebhook } from '../../src/automation/webhook.js'
import { certificateDirectory } from '../api/fixtures.js'
import { config, bearerToken, webhookRequest } from './fixtures.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function start(maximumBytes = 65536, bodyTimeoutMs = 2000) {
  const base = config('C:/webhook-only-fixture', 1), calls: unknown[] = []
  const [cert, key] = await Promise.all(['server.pem', 'server-key.pem'].map(name => readFile(`${certificateDirectory}${name}`)))
  const service = await openAutomationWebhook({ config: { ...base, limits: { ...base.limits, maxRequestBytes: maximumBytes, requestReadTimeoutMs: bodyTimeoutMs } }, cert: cert!, key: key!, token: bearerToken,
    async accept(jobKey, eventId, text) { calls.push({ jobKey, eventId, text }); return { reused: false } }, status: () => ({ ready: true }) })
  cleanup.push(() => service.dispose()); return { service, calls }
}
describe('authenticated bounded webhook', () => {
  it('authenticates before accepting any fixed Job data and does not expose local acknowledgement', async () => {
    const { service, calls } = await start()
    expect((await webhookRequest(service.listen.port, { eventId: 'one', text: 'research' }, 'wrong')).status).toBe(401)
    expect((await webhookRequest(service.listen.port, { eventId: 'one', text: 'research' }, bearerToken, '/automation/v1/webhooks/unconfigured')).status).toBe(400)
    expect((await webhookRequest(service.listen.port, { eventId: 'one', text: 'research', agentKey: 'other' })).status).toBe(400)
    expect((await webhookRequest(service.listen.port, { triggerKey: 'a'.repeat(64) }, bearerToken, '/automation/v1/acknowledge')).status).toBe(400)
    expect(calls).toEqual([])
    expect((await webhookRequest(service.listen.port, { eventId: 'one', text: 'research' })).status).toBe(202)
    expect(calls).toEqual([{ jobKey: 'review', eventId: 'one', text: 'research' }])
    expect((await webhookRequest(service.listen.port, null, bearerToken, '/automation/v1/status', 'GET')).body).toEqual({ ready: true })
  })
  it('rejects oversized and malformed JSON before business admission', async () => {
    const { service, calls } = await start(128)
    expect((await webhookRequest(service.listen.port, { eventId: 'one', text: 'x'.repeat(200) })).status).toBe(429)
    expect((await webhookRequest(service.listen.port, '{broken')).status).toBe(400)
    expect((await webhookRequest(service.listen.port, Buffer.from([0xff]))).status).toBe(400)
    expect(calls).toEqual([])
  })
  it('expires an incomplete request body without admitting its payload', async () => {
    const { service, calls } = await start(65536, 50), ca = await readFile(`${certificateDirectory}ca.pem`)
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port: service.listen.port, servername: 'localhost', ca, method: 'POST', path: '/automation/v1/webhooks/review',
        headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json', 'content-length': 100 } }, incoming => { incoming.resume(); incoming.once('end', () => resolve(incoming.statusCode!)) })
      outgoing.once('error', reject); outgoing.write('{')
    })
    expect(status).toBe(429); expect(calls).toEqual([])
  })
})

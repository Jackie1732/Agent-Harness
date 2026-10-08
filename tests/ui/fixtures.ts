import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeHost } from '../../src/host/initialization.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import { openHarnessUiServer } from '../../src/ui/server.js'
import { decodeUiConfig, resolveUiConfig } from '../../src/ui/config.js'
import type { UiConfig } from '../../src/ui/config.js'
import type { ControlMethod, Result, ApiErrorData } from '../../src/protocol/index.js'
import { twoMemberHostConfig } from '../host/fixtures.js'
import { apiConfig, certificateDirectory, clientOptions } from '../api/fixtures.js'

export function uiConfig(port: number): UiConfig {
  return { schemaVersion: 1, listenPort: 0, remote: { origin: `https://127.0.0.1:${port}`, serverName: 'localhost',
    caFile: `${certificateDirectory}ca.pem`, certFile: `${certificateDirectory}client.pem`, keyFile: `${certificateDirectory}client-key.pem`,
    limits: { maxRequestBytes: 1048576, maxResponseBytes: 2097152, maxJsonDepth: 64, maxJsonNodes: 100000, connectTimeoutMs: 3000, requestTimeoutMs: 20000, maxConnections: 4 } },
    passwordEnv: 'ATOMIC_UI_TEST_PASSWORD', memberKeys: ['writer', 'reviewer'], workflowKeys: [],
    limits: { maxRequestBytes: 1048576, maxJsonDepth: 64, maxJsonNodes: 100000, maxHeaderBytes: 8192, maxConnections: 16, maxPendingRequests: 8,
      requestReadTimeoutMs: 3000, responseWriteTimeoutMs: 3000, headersTimeoutMs: 3000, keepAliveTimeoutMs: 1000, sessionTimeoutMs: 60000 } }
}
export const password = 'local-ui-test-password'
export async function uiFixture(options: { readonly question?: boolean; readonly maxPendingRequests?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-ui-')), raw = twoMemberHostConfig(join(directory, 'store'))
  if (options.question) {
    const member = (raw.members as Array<Record<string, unknown>>)[0]!
    member.spec = { ...(member.spec as object), nativeActions: ['agent_ask_user', 'agent_send_message'] }
    const model = member.model as Record<string, unknown>
    model.runnerLimits = { ...(model.runnerLimits as object), maxToolCalls: 1 }
  }
  const host = resolveHostConfig(decodeHostConfig(raw, directory)); await initializeHost(host)
  if (options.question) {
    const seed = await openHost(host, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model, script: async function* () {
      yield { kind: 'message-start', responseId: 'ui-question', reportedModel: member.spec.target.model }
      yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'question', name: 'agent_ask_user' }
      yield { kind: 'arguments-delta', index: 0, text: '{"question":"确认继续研究？","timeoutMs":60000}' }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
    } }) } })
    try { await seed.submitTask('writer', 'Question'); await seed.run() } finally { await seed.shutdown({ mode: 'drain' }) }
  }
  const api = await apiConfig()
  const service = await openHarnessApiServer({ host, api: resolveApiConfig(decodeApiConfig({ ...api,
    principals: [{ ...api.principals[0]!, agentKeys: ['writer', 'reviewer'] }] }), host, directory), credentials: {} })
  const config = uiConfig(service.ready.listen.port)
  const ui = await openHarnessUiServer({ config: resolveUiConfig(decodeUiConfig({ ...config, limits: { ...config.limits,
    ...(options.maxPendingRequests === undefined ? {} : { maxPendingRequests: options.maxPendingRequests }) } }), directory), password })
  const http = async (path: string, body?: unknown, cookie?: string) => await fetch(`${ui.ready.url}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin: ui.ready.url, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const login = await http('/api/login', { password }), cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const rpc = async <M extends ControlMethod>(method: M, params: unknown) => {
    const response = await http('/api/control', { method, params }, cookie)
    const json = await response.json() as { readonly result?: Result<M>; readonly error?: ApiErrorData }
    return { status: response.status, body: {
      get result(): Result<M> { if (json.result === undefined) throw new Error(`Expected result, received ${json.error?.code}`); return json.result },
      get error(): ApiErrorData { if (json.error === undefined) throw new Error('Expected gateway rejection'); return json.error },
    } }
  }
  return { directory, host, service, ui, config, cookie, http, rpc, options: await clientOptions(service.ready.listen.port),
    async dispose() { await ui.dispose(); await service.dispose(); await rm(directory, { recursive: true, force: true }) } }
}

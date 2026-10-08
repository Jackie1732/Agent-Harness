import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { X509Certificate } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import * as h from '../dist/index.js'
import { openHarnessApiServer, decodeApiConfig, resolveApiConfig } from '@atomic-harness/core/api'
import { openHarnessUiServer, decodeUiConfig, resolveUiConfig } from '@atomic-harness/core/ui'
import { CONTROL_METHODS } from '@atomic-harness/core/protocol'
import { createHarnessClient } from '@atomic-harness/core/client'
import { workflowConfig, resolveWorkflowConfig } from '../examples/workflow-fixture.mjs'
import { subagentConfig } from '../examples/subagent-fixture.mjs'

/** Real File Host, mTLS API and packaged browser gateway for built and interactive acceptance. */
export async function builtUiFixture({ question = false, workflow = false, child = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-ui-built-'))
  const raw = workflow ? await workflowConfig(join(directory,'store')) : child ? await subagentConfig(join(directory,'store'))
    : JSON.parse(await readFile(new URL('../examples/host-config.json',import.meta.url),'utf8'))
  raw.storage.root = join(directory,'store')
  if (question) { if (!raw.members[0].spec.nativeActions.includes('agent_ask_user')) raw.members[0].spec.nativeActions.push('agent_ask_user'); raw.members[0].model.runnerLimits.maxToolCalls = 1; raw.members[0].spec.rootDurationMs = 600000; raw.members[0].spec.limits.maxWaitMs = 600000 }
  const host = workflow ? resolveWorkflowConfig(raw) : h.resolveHostConfig(h.decodeHostConfig(raw,directory))
  await h.initializeHost(host)
  if (question) {
    const seed = await h.openHost(host,{bindings:{createModelProvider:member => new h.ScriptedModelProvider({...member.model,script:async function* () {
      yield {kind:'message-start',reportedModel:member.spec.target.model,responseId:'ui-human'}
      yield {kind:'block-start',index:0,block:'tool-call',callId:'human',name:'agent_ask_user'}
      yield {kind:'arguments-delta',index:0,text:'{"question":"请确认研究结果应使用 Markdown 格式？","timeoutMs":600000}'}
      yield {kind:'block-end',index:0}; yield {kind:'complete',stopReason:'tool-calls'}
    }})}})
    try { await seed.submitTask('writer','Confirm the research format'); await seed.run() } finally { await seed.shutdown({mode:'drain'}) }
  }
  const certRoot = fileURLToPath(new URL('./host/certs/',import.meta.url)), password = 'local-ui-acceptance-only', memberKeys = raw.members.map(member => member.agentKey)
  const fingerprint = new X509Certificate(await readFile(join(certRoot,'client.pem'))).fingerprint256.replaceAll(':','').toLowerCase()
  const api = decodeApiConfig({schemaVersion:1,listenHost:'127.0.0.1',listenPort:0,tls:{caFile:join(certRoot,'ca.pem'),serverCertFile:join(certRoot,'server.pem'),serverKeyFile:join(certRoot,'server-key.pem')},
    principals:[{principalKey:'researcher',certificateFingerprints:[fingerprint],methods:[...CONTROL_METHODS],agentKeys:memberKeys,workflowKeys:workflow?['research']:[]}],
    limits:{maxRequestBytes:1048576,maxResponseBytes:2097152,maxJsonDepth:64,maxJsonNodes:100000,maxHeaderBytes:8192,maxPageEvents:100,maxConnections:16,maxPendingInputs:4,maxPendingControls:4,maxObservers:4,maxPendingShutdowns:4,requestReadTimeoutMs:5000,responseWriteTimeoutMs:5000,tlsHandshakeTimeoutMs:5000,headersTimeoutMs:5000,keepAliveTimeoutMs:1000,maxWaitMs:5000,observerScanIntervalMs:5}})
  const service = await openHarnessApiServer({host,api:resolveApiConfig(api,host,directory),credentials:{}})
  const config = decodeUiConfig({schemaVersion:1,listenPort:0,passwordEnv:'ATOMIC_UI_ACCEPTANCE_PASSWORD',memberKeys,workflowKeys:workflow?['research']:[],
    remote:{origin:`https://127.0.0.1:${service.ready.listen.port}`,serverName:'localhost',caFile:join(certRoot,'ca.pem'),certFile:join(certRoot,'client.pem'),keyFile:join(certRoot,'client-key.pem'),
      limits:{maxRequestBytes:1048576,maxResponseBytes:2097152,maxJsonDepth:64,maxJsonNodes:100000,connectTimeoutMs:5000,requestTimeoutMs:60000,maxConnections:4}},
    limits:{maxRequestBytes:1048576,maxJsonDepth:64,maxJsonNodes:100000,maxHeaderBytes:8192,maxConnections:16,maxPendingRequests:8,requestReadTimeoutMs:5000,responseWriteTimeoutMs:5000,headersTimeoutMs:5000,keepAliveTimeoutMs:1000,sessionTimeoutMs:3600000}})
  const ui = await openHarnessUiServer({config:resolveUiConfig(config,directory),password})
  return {directory,ui,service,password,config,async dispose(){await ui.dispose();await service.dispose();await rm(directory,{recursive:true,force:true})}}
}

/** Accept one real keyed input before losing its receipt; other requests retain normal control responses. */
export async function builtUiLostReceiptFixture() {
  const fixture = await builtUiFixture(), certRoot = new URL('./host/certs/', import.meta.url)
  const [ca, cert, key, clientCert, clientKey] = await Promise.all(['ca.pem','server.pem','server-key.pem','client.pem','client-key.pem'].map(name => readFile(new URL(name, certRoot))))
  const relay = createHarnessClient({ origin: fixture.config.remote.origin, serverName: 'localhost',
    tls: { ca, cert: clientCert, key: clientKey }, limits: fixture.config.remote.limits })
  let accepted, releaseReceipt, submissions = 0
  const waitAccepted = new Promise(resolve => { accepted = resolve }), held = new Promise(resolve => { releaseReceipt = resolve })
  const proxy = createHttpsServer({ ca, cert, key, requestCert: true, rejectUnauthorized: true }, (request, response) => {
    void (async () => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const call = JSON.parse(Buffer.concat(chunks).toString())
      if (call.method === 'input.submit') submissions++
      const result = await relay.request(call.method, call.params)
      if (call.method === 'input.submit' && call.params.submissionKey === 'unknown-original') { accepted(); await held; response.destroy(); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ protocol: call.protocol, version: call.version, requestId: call.requestId, kind: 'result', result }))
    })().catch(() => response.destroy())
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const config = decodeUiConfig({ ...fixture.config, remote: { ...fixture.config.remote, origin: `https://127.0.0.1:${proxy.address().port}` } })
  await fixture.ui.dispose()
  const ui = await openHarnessUiServer({ config, password: fixture.password })
  return { ...fixture, ui, waitAccepted, releaseReceipt, get submissions() { return submissions },
    async dispose() { releaseReceipt(); await ui.dispose(); await new Promise(resolve => proxy.close(resolve)); await relay.close(); await fixture.dispose() } }
}

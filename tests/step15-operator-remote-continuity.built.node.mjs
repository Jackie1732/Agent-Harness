import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarnessClient } from '../dist/client/index.js'
import { buildOperatorProfile } from '../dist/operator/profile.js'
import { builtUiFixture } from './ui-built-fixture.mjs'

const bin = fileURLToPath(new URL('../dist/host/bin.js', import.meta.url))
const certRoot = fileURLToPath(new URL('./host/certs/', import.meta.url))

// Only the child process changes its response sink; the real SDK still sends and classifies every mTLS request.
function wireProbe(dropMethod) {
  return `data:text/javascript,${encodeURIComponent(`
    import https from 'node:https';
    import { syncBuiltinESMExports } from 'node:module';
    const original = https.request, target = ${JSON.stringify(dropMethod ?? null)};
    let dropped = false;
    https.request = (url, options, receive) => {
      let method;
      const outgoing = original(url, options, response => {
        receive(response);
        if (!dropped && method === target) {
          dropped = true;
          process.stderr.write('STEP15_DROPPED ' + method + '\\n');
          response.destroy();
        }
      });
      const end = outgoing.end.bind(outgoing);
      outgoing.end = (body, ...args) => {
        method = JSON.parse(body.toString()).method;
        process.stderr.write('STEP15_WIRE ' + method + '\\n');
        return end(body, ...args);
      };
      return outgoing;
    };
    syncBuiltinESMExports();
  `)}`
}

/** Run a separate shipped CLI and observe real outgoing methods and socket receipt loss. */
function command(fixture, args, { input = '', exitCode = 0, dropMethod } = {}) {
  const child = spawn(process.execPath, ['--import', wireProbe(dropMethod), bin, ...args,
    '--profile', fixture.profilePath, '--json'], { cwd: fixture.directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.on('error', () => { /* A rejected command can finish before consuming its finite fixture input. */ })
  child.stdin.end(input)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Remote CLI deadline: ${args.join(' ')}`)) }, 30000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      try {
        assert.equal(signal, null, stderr); assert.equal(code, exitCode, `${stderr}\n${stdout}`)
        const methods = [...stderr.matchAll(/^STEP15_WIRE (.+)$/gm)].map(match => match[1])
        const dropped = [...stderr.matchAll(/^STEP15_DROPPED (.+)$/gm)].map(match => match[1])
        if (dropMethod !== undefined) assert.deepEqual(dropped, [dropMethod])
        fixture.methods.push(...methods)
        resolve(JSON.parse(stdout))
      } catch (error) { reject(error) }
    })
  })
}

async function fixture() {
  const service = await builtUiFixture(), remote = service.config.remote
  const profilePath = join(service.directory, 'operator.json')
  const raw = buildOperatorProfile({ kind: 'remote', origin: remote.origin, serverName: 'localhost',
    tlsFiles: { ca: join(certRoot, 'ca.pem'), cert: join(certRoot, 'client.pem'), key: join(certRoot, 'client-key.pem') },
    limits: remote.limits, targets: { agentKeys: ['writer', 'reviewer'], workflowKeys: [] } })
  await writeFile(profilePath, JSON.stringify(raw))
  const [ca, cert, key] = await Promise.all(['ca.pem', 'client.pem', 'client-key.pem'].map(name => readFile(join(certRoot, name))))
  const manager = createHarnessClient({ origin: remote.origin, serverName: 'localhost', tls: { ca, cert, key }, limits: remote.limits })
  return { ...service, profilePath, manager, methods: [], async dispose() { await manager.close(); await service.dispose() } }
}

test('real remote receipt loss retains acceptance, explicit keyed continuity and the independent API service', { timeout: 90000 }, async () => {
  const f = await fixture(), args = ['task', 'submit', '--agent', 'writer', '--key', 'remote-unknown-input', '--text', '真实 mTLS 接纳后丢回执']
  try {
    const first = await command(f, args, { dropMethod: 'input.submit', exitCode: 4 })
    assert.equal(first.acceptance, 'unknown'); assert.equal(first.error.code, 'OPERATOR_CONNECTION_FAILED')
    assert.equal(first.closing.status, 'not-owned')
    assert.equal(f.service.status, 'ready')
    const queried = await command(f, ['task', 'get', '--agent', 'writer', '--key', 'remote-unknown-input'])
    assert.equal(queried.result.status, 'queued'); assert.equal(queried.result.rootId, null)
    assert.deepEqual(queried.result.submission, { namespace: 'api:researcher', key: 'remote-unknown-input' })
    const firstFacts = (await command(f, ['journal', 'inspect'])).result
    const firstPrepared = firstFacts.find(fact => fact.kind === 'prepared' && fact.intent.id === first.operationId)
    assert.equal(firstPrepared.intent.callerNamespace, null)
    assert.equal(firstPrepared.intent.scope.sessionId, queried.result.sessionId)
    assert.equal(firstPrepared.intent.params.text, '真实 mTLS 接纳后丢回执')
    const unconfirmed = await command(f, ['intent', 'resume', '--id', first.operationId], { exitCode: 3 })
    assert.equal(unconfirmed.error.code, 'OPERATOR_CALLER_UNCONFIRMED')
    assert.equal(f.methods.filter(method => method === 'input.submit').length, 1)

    const second = await command(f, args, { dropMethod: 'input.submit', exitCode: 4 })
    assert.equal(second.acceptance, 'unknown')
    const restored = await command(f, ['intent', 'resume', '--id', second.operationId])
    assert.equal(restored.acceptance, 'accepted'); assert.equal(restored.result.reused, true)
    assert.equal(restored.result.inputEventId, queried.result.inputEventId)
    assert.equal(restored.closing.status, 'not-owned')
    const facts = (await command(f, ['journal', 'inspect'])).result
    assert.equal(facts.find(fact => fact.kind === 'prepared' && fact.intent.id === second.operationId).intent.callerNamespace, 'api:researcher')
    assert.equal(facts.find(fact => fact.kind === 'prepared' && fact.intent.id === restored.operationId).intent.parentIntent, second.operationId)
    for (const operationId of [first.operationId, second.operationId]) {
      assert.deepEqual(facts.filter(fact => fact.kind === 'outcome' && fact.intentId === operationId).map(fact => fact.outcome.acceptance), ['unknown'])
    }
    const status = await f.manager.request('host.status', {})
    assert.equal(status.hostStatus, 'ready'); assert.equal(status.report.counts.pendingInputs, 1)
    assert.equal(status.report.members.find(member => member.agentKey === 'writer').agent.counts.inputs, 1)
    assert.equal(status.report.members.find(member => member.agentKey === 'writer').agent.counts.roots, 0)
    assert.equal(f.methods.filter(method => method === 'input.submit').length, 3)
    assert.equal(f.methods.filter(method => method === 'host.run' || method === 'message.send').length, 0)
    const page = await f.manager.request('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 100 })
    const accepted = page.events.filter(event => event.type === 'agent/input-accepted' && event.payload.submission?.key === 'remote-unknown-input')
    assert.equal(accepted.length, 1); assert.equal(accepted[0].eventId, queried.result.inputEventId)
  } finally { await f.dispose() }
})

test('remote message and completed Run receipt loss never repeats either mutation on later CLI attachment', { timeout: 90000 }, async () => {
  const f = await fixture()
  try {
    const message = await command(f, ['message', 'send', '--params-stdin'], { dropMethod: 'message.send', exitCode: 4,
      input: JSON.stringify({ agentKey: 'writer', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"仅发送一次"}' }) })
    assert.equal(message.acceptance, 'unknown'); assert.equal(message.closing.status, 'not-owned')
    assert.equal((await f.manager.request('host.status', {})).report.counts.pendingOutbox, 1)
    await command(f, ['task', 'submit', '--agent', 'writer', '--key', 'remote-run-input', '--text', '有限批次完成后丢回执'])
    const run = await command(f, ['run-once'], { dropMethod: 'host.run', exitCode: 4 })
    assert.equal(run.acceptance, 'unknown'); assert.equal(run.error.code, 'OPERATOR_CONNECTION_FAILED')
    const observed = await command(f, ['task', 'get', '--agent', 'writer', '--key', 'remote-run-input'])
    assert.equal(observed.result.status, 'handled')
    assert.equal((await f.manager.request('root.get', { agentKey: 'writer', rootId: observed.result.rootId })).outcome, 'completed')
    const blocked = await command(f, ['run-once'], { exitCode: 10 })
    assert.equal(blocked.error.code, 'OPERATOR_RUN_UNKNOWN_REQUIRED'); assert.equal(blocked.operationId, null)
    assert.equal(f.methods.filter(method => method === 'host.run').length, 1)
    assert.equal(f.methods.filter(method => method === 'message.send').length, 1)
    const facts = (await command(f, ['journal', 'inspect'])).result
    for (const operationId of [message.operationId, run.operationId]) {
      assert.deepEqual(facts.filter(fact => fact.kind === 'outcome' && fact.intentId === operationId).map(fact => fact.outcome.acceptance), ['unknown'])
      assert.equal(facts.filter(fact => fact.kind === 'prepared' && fact.intent.id === operationId).length, 1)
    }
    assert.equal((await f.manager.request('host.status', {})).hostStatus, 'ready')
    assert.equal((await command(f, ['status'])).result.hostStatus, 'ready')
    assert.equal(f.methods.filter(method => method === 'host.run').length, 1)
    assert.equal(f.methods.filter(method => method === 'message.send').length, 1)
  } finally { await f.dispose() }
})

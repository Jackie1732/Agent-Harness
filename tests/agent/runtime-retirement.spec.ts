import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionAgent, SessionModelRunner, createMessageCatalog, FileSessionBackend, projectAgentSession,
  agentSessionEventDefinitions, communicationSessionEventDefinitions, toolSessionEventDefinitions } from '../../src/index.js'
import { createFileSessionBackendForTest } from '../../src/session/file-backend.js'
import { writeAll } from '../../src/session/file-store.js'
import { runnerLimits, repository } from '../context/fixtures.js'
import { agentFixture, clock } from './fixtures.js'
import { auditProvider, createDeferred, interceptedBackend } from './audit-fixtures.js'

async function releasedAgent(run: boolean, failClose: boolean) {
  const catalog = createMessageCatalog()
  const provider = auditProvider({ onClose: () => { if (failClose) throw new Error('release failed') } })
  const f = await agentFixture({}, provider, catalog)
  const model = new SessionModelRunner({ session: f.session, provider, limits: runnerLimits })
  const lifetime = new AbortController()
  const agent = new SessionAgent({ session: f.session, context: f.context, model, messageCatalog: catalog, clock, signal: lifetime.signal })
  let task
  if (run) {
    await agent.submitInput({ kind: 'task', text: 'complete', originLabel: 'retirement' })
    task = agent.start(); await task
  }
  const snapshot = agent.snapshot()
  const report = agent.report()
  const close = agent.dispose()
  if (failClose) await assert.rejects(close, { code: 'AGENT_CLEANUP_FAILED' })
  else await close
  expect(f.session.status).toBe('open')
  const refs = { session: new WeakRef(f.session), context: new WeakRef(f.context), model: new WeakRef(model),
    provider: new WeakRef(provider), catalog: new WeakRef(catalog), signal: new WeakRef(lifetime.signal) }
  await f.close().catch(() => undefined)
  return { agent, task, close, refs, snapshot, report }
}

it.each([[false, false], [true, false], [true, true]])('retires settled Agent resources: run=%s, cleanup failure=%s', async (run, failClose) => {
  const { agent, task, close, refs, snapshot, report } = await releasedAgent(run, failClose)
  await setImmediate()
  queryObjects(SessionAgent, { format: 'count' })
  expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined])))
    .toEqual({ session: false, context: false, model: false, provider: false, catalog: false, signal: false })
  expect(agent.status).toBe('disposed')
  expect(agent.dispose()).toBe(close)
  for (const observe of [() => agent.snapshot(), () => agent.report(), () => agent.readiness(), () => agent.wait()]) {
    expect(observe).toThrowError(expect.objectContaining({ code: 'AGENT_INACTIVE' }))
  }
  expect(() => agent.start()).toThrowError(expect.objectContaining({ code: 'AGENT_INACTIVE' }))
  expect(snapshot.spec?.payload.label).toBe('test')
  expect(report.counts.roots).toBe(run ? 1 : 0)
  if (task !== undefined) expect((await task).roots[0]?.outcome).toBe(failClose ? 'result-unknown' : 'completed')
  if (failClose) await assert.rejects(close, { code: 'AGENT_CLEANUP_FAILED' })
  else await close
})

it('joins an accepted input append before retiring runtime', async () => {
  const entered = createDeferred<void>(), release = createDeferred<void>()
  const backend = interceptedBackend(async event => {
    if (event.type === 'agent/input-accepted') { entered.resolve(); await release.promise }
  })
  const f = await agentFixture({}, undefined, createMessageCatalog(), backend)
  const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  const agent = new SessionAgent({ session: f.session, context: f.context, model, messageCatalog: createMessageCatalog(), clock })
  try {
    const pending = agent.submitInput({ kind: 'task', text: 'accepted', originLabel: 'retirement' })
    await entered.promise
    const close = agent.dispose()
    let settled = false; void close.then(() => { settled = true })
    await setImmediate()
    expect(settled).toBe(false)
    expect(model.status).toBe('accepting')
    expect(() => agent.submitInput({ kind: 'task', text: 'late', originLabel: 'retirement' }))
      .toThrowError(expect.objectContaining({ code: 'AGENT_INACTIVE' }))
    release.resolve(); await pending; await close
    expect(projectAgentSession(f.session.snapshot()).inputs[0]?.status).toBe('queued')
    expect(f.session.status).toBe('open')
  } finally { release.resolve(); await agent.dispose(); await f.close() }
})

async function faultedAgent() {
  const root = await mkdtemp(join(tmpdir(), 'atomic-agent-retirement-'))
  let loseAcknowledgement = false
  const backend = createFileSessionBackendForTest({ root, maxRecordBytes: 2 * 1024 * 1024 }, {
    writeAll, sync: async file => { await file.sync(); if (loseAcknowledgement) throw new Error('lost acknowledgement') },
  })
  const catalog = createMessageCatalog()
  const f = await agentFixture({}, undefined, catalog, backend)
  const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
  const agent = new SessionAgent({ session: f.session, context: f.context, model, messageCatalog: catalog, clock })
  try {
    loseAcknowledgement = true
    const pending = agent.submitInput({ kind: 'task', text: 'durable despite lost acknowledgement', originLabel: 'retirement' })
    await assert.rejects(pending, { code: 'AGENT_COMMIT_UNKNOWN' })
    expect(agent.status).toBe('faulted')
    const failure = agent.failure
    const close = agent.dispose(); await close
    const refs = { session: new WeakRef(f.session), context: new WeakRef(f.context), model: new WeakRef(model), catalog: new WeakRef(catalog) }
    const id = f.session.header.sessionId
    await f.close()
    const reopened = repository(new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }),
      [...agentSessionEventDefinitions, ...communicationSessionEventDefinitions, ...toolSessionEventDefinitions])
    let snapshot
    try { snapshot = projectAgentSession((await reopened.open(id)).snapshot()) }
    finally { await reopened.dispose() }
    return { agent, pending, close, failure, refs, snapshot }
  } finally { await agent.dispose(); await f.close(); await rm(root, { recursive: true, force: true }) }
}

it('retires runtime after a lost File acknowledgement without erasing its durable input or original failure', async () => {
  const { agent, pending, close, failure, refs, snapshot } = await faultedAgent()
  await setImmediate()
  queryObjects(SessionAgent, { format: 'count' })
  expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined])))
    .toEqual({ session: false, context: false, model: false, catalog: false })
  expect(agent.dispose()).toBe(close)
  expect(agent.failure).toBe(failure)
  await assert.rejects(pending, reason => reason === failure)
  expect(snapshot.inputs[0]).toMatchObject({ status: 'queued', input: { text: 'durable despite lost acknowledgement' } })
})

import { rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import * as connections from '../src/operator/connection.js'
import { openOperatorSession } from '../src/operator/session.js'
import { inspectOperatorJournal } from '../src/operator/intents.js'
import type { OperatorFact } from '../src/operator/intent-events.js'
import type { ResolvedOperatorProfile } from '../src/operator/profile.js'
import type { OperatorSession } from '../src/operator/types.js'
import { ClientTransportError } from '../src/client/errors.js'
import type { ApplicationResult } from '../src/control/types.js'
import type { ControlMethod, Params, Result } from '../src/protocol/index.js'
import { localFixture } from './step15-operator-fixture.js'

function loseFirstReceipt(profile: ResolvedOperatorProfile, point: 'before-input' | 'after-input' | 'after-run') {
  const original = connections.openOperatorConnection
  const inputReceipts: Result<'input.submit'>[] = [], runReceipts: Result<'host.run'>[] = []
  let lost = false, forwardedInputs = 0
  vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
    const connection = await original(...args)
    return { ...connection, request: async <M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal) => {
      const lose = !lost && method === (point === 'after-run' ? 'host.run' : 'input.submit')
      if (lose) {
        lost = true
        const prepared = (await inspectOperatorJournal(profile)).filter(fact => fact.kind === 'prepared').at(-1)
        expect(prepared).toMatchObject({ intent: { method, params, callerNamespace: profile.callerNamespace,
          certificateFingerprint: null, parentIntent: null, acknowledgedIntent: null,
          scope: { connection: 'local', connectionLifetime: 'session' } } })
        if (point === 'before-input') throw new ClientTransportError('unknown')
      }
      if (method === 'input.submit') forwardedInputs++
      const result = await connection.request(method, params, signal)
      if (method === 'input.submit') inputReceipts.push(result as Result<'input.submit'>)
      if (method === 'host.run') runReceipts.push(result as Result<'host.run'>)
      if (lose) throw new ClientTransportError('unknown')
      return result as ApplicationResult<M>
    } }
  })
  return { inputReceipts, runReceipts, forwardedInputs: () => forwardedInputs }
}

async function status(session: OperatorSession) {
  const observation = await session.execute('host.status', {})
  expect(observation.status).toBe('ok')
  return observation.result as Result<'host.status'>
}

async function input(session: OperatorSession, key: string) {
  const observation = await session.execute('input.get', { agentKey: 'writer', submissionKey: key })
  expect(observation.status).toBe('ok')
  return observation.result as Result<'input.get'>
}

async function agent(session: OperatorSession) {
  const observation = await session.execute('agent.get', { agentKey: 'writer' })
  expect(observation.status).toBe('ok')
  return observation.result as Result<'agent.get'>
}

async function acceptedInputs(session: OperatorSession) {
  const observation = await session.execute('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 64 })
  expect(observation.status).toBe('ok')
  return (observation.result as Result<'session.events'>).events.filter(event => event.type === 'agent/input-accepted')
}

it('explicitly resumes a durable preparation that never reached input submission on a new local instance', async () => {
  const f = await localFixture(), fault = loseFirstReceipt(f.profile, 'before-input')
  let session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  const params = { agentKey: 'writer', submissionKey: 'prepared-not-sent', text: '原 prepared 文本\n保持同一键' }
  try {
    const lost = await session.submit(params)
    expect(lost).toMatchObject({ status: 'unknown', acceptance: 'unknown', error: { code: 'OPERATOR_CONNECTION_FAILED' } })
    const original = session.intents()[0]!
    expect(original).toMatchObject({ id: lost.operationId, params, callerNamespace: f.profile.callerNamespace,
      scope: { hostKey: f.spec.hostKey, instanceId: lost.scope.instanceId, sessionId: f.spec.members[0]!.sessionId },
      outcome: { acceptance: 'unknown' } })
    expect(fault.forwardedInputs()).toBe(0)
    expect((await status(session)).report.counts.pendingInputs).toBe(0)
    expect(await acceptedInputs(session)).toHaveLength(0)
    await session.close('drain')
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    expect((await status(session)).instanceId).not.toBe(original.scope.instanceId)
    expect(fault.forwardedInputs()).toBe(0)
    const resumed = await session.resume(original.id)
    expect(resumed).toMatchObject({ status: 'ok', acceptance: 'accepted', result: { reused: false, sessionId: original.scope.sessionId } })
    expect(session.intents()[1]).toMatchObject({ id: resumed.operationId, method: 'input.submit', params,
      parentIntent: original.id, outcome: { acceptance: 'accepted', summary: { submissionKey: params.submissionKey,
        namespace: f.profile.callerNamespace, reused: false } } })
    expect(session.intents()[0]).toEqual(original)
    expect(fault.forwardedInputs()).toBe(1)
    expect(fault.runReceipts).toHaveLength(0)
    expect(await input(session, params.submissionKey)).toMatchObject({ status: 'queued', rootId: null,
      submission: { namespace: f.profile.callerNamespace, key: params.submissionKey } })
    expect((await agent(session)).report.counts).toMatchObject({ inputs: 1, roots: 0, modelUsage: 0 })
    expect(await acceptedInputs(session)).toHaveLength(1)
    const facts = await inspectOperatorJournal(f.profile)
    expect(facts.filter(fact => fact.kind === 'prepared')).toHaveLength(2)
    expect(facts.find(fact => fact.kind === 'outcome' && fact.intentId === original.id)).toMatchObject({ outcome: original.outcome })
  } finally { vi.restoreAllMocks(); await session.close('drain'); await rm(f.directory, { recursive: true, force: true }) }
})

it('explicitly resumes a lost accepted receipt with the original keyed input and never runs it automatically', async () => {
  const f = await localFixture(), fault = loseFirstReceipt(f.profile, 'after-input')
  let session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  const params = { agentKey: 'writer', submissionKey: 'accepted-lost-receipt', text: '接纳后回执丢失的原文本' }
  try {
    const lost = await session.submit(params), original = session.intents()[0]!
    expect(lost.acceptance).toBe('unknown')
    expect(fault.inputReceipts).toHaveLength(1)
    const receipt = fault.inputReceipts[0]!
    expect(receipt.reused).toBe(false)
    expect(await input(session, params.submissionKey)).toMatchObject({ status: 'queued', rootId: null, inputEventId: receipt.inputEventId })
    await session.close('drain')
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    expect((await status(session)).instanceId).not.toBe(original.scope.instanceId)
    expect(fault.forwardedInputs()).toBe(1)
    expect((await status(session)).report.counts.pendingInputs).toBe(1)
    const resumed = await session.resume(original.id)
    expect(resumed).toMatchObject({ status: 'ok', acceptance: 'accepted', result: { ...receipt, reused: true } })
    expect(session.intents()[1]).toMatchObject({ parentIntent: original.id, params,
      outcome: { acceptance: 'accepted', summary: { inputEventId: receipt.inputEventId, namespace: f.profile.callerNamespace, reused: true } } })
    expect(session.intents()[0]).toEqual(original)
    expect(fault.inputReceipts.map(item => item.reused)).toEqual([false, true])
    expect(fault.runReceipts).toHaveLength(0)
    expect((await agent(session)).report.counts).toMatchObject({ inputs: 1, roots: 0, modelUsage: 0 })
    expect(await acceptedInputs(session)).toHaveLength(1)
  } finally { vi.restoreAllMocks(); await session.close('drain'); await rm(f.directory, { recursive: true, force: true }) }
})

it('returns the original key conflict when explicit resume meets different accepted content', async () => {
  const f = await localFixture(), fault = loseFirstReceipt(f.profile, 'before-input')
  let session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  const params = { agentKey: 'writer', submissionKey: 'resume-conflict', text: '未发送的原 prepared 内容' }
  try {
    const lost = await session.submit(params), original = session.intents()[0]!
    expect(lost.acceptance).toBe('unknown')
    const different = { ...params, text: '同一 caller/key 已接纳的不同内容' }
    expect(await session.submit(different)).toMatchObject({ acceptance: 'accepted', result: { reused: false } })
    await session.close('drain')
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    const conflict = await session.resume(original.id)
    expect(conflict).toMatchObject({ status: 'rejected', acceptance: 'not-accepted',
      error: { code: 'API_KEY_CONFLICT', domainCode: 'AGENT_KEY_CONFLICT' } })
    expect(session.intents().at(-1)).toMatchObject({ parentIntent: original.id, params,
      outcome: { acceptance: 'not-accepted', errorCode: 'API_KEY_CONFLICT' } })
    expect(session.intents()[0]).toEqual(original)
    expect(fault.forwardedInputs()).toBe(2)
    expect(fault.inputReceipts).toHaveLength(1)
    expect(fault.runReceipts).toHaveLength(0)
    expect((await agent(session)).report.counts).toMatchObject({ inputs: 1, roots: 0, modelUsage: 0 })
    const events = await acceptedInputs(session)
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ input: { text: different.text },
      submission: { namespace: f.profile.callerNamespace, key: params.submissionKey } })
  } finally { vi.restoreAllMocks(); await session.close('drain'); await rm(f.directory, { recursive: true, force: true }) }
})

it('requires the original unknown Run acknowledgement for every new batch without rewriting it', async () => {
  const f = await localFixture(), fault = loseFirstReceipt(f.profile, 'after-run')
  let session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    expect(await session.submit({ agentKey: 'writer', submissionKey: 'unknown-run-first', text: '实际完成第一批' })).toMatchObject({ acceptance: 'accepted' })
    const firstStatus = await status(session)
    const lost = await session.execute('host.run', { expectedInstanceId: firstStatus.instanceId })
    expect(lost).toMatchObject({ status: 'unknown', acceptance: 'unknown', error: { code: 'OPERATOR_CONNECTION_FAILED' } })
    expect(fault.runReceipts).toHaveLength(1)
    expect(fault.runReceipts[0]!.report.businessRuns).toBe(1)
    const original = session.intents().find(intent => intent.id === lost.operationId)!
    expect(original).toMatchObject({ method: 'host.run', params: { expectedInstanceId: firstStatus.instanceId },
      acknowledgedIntent: null, acknowledgementReason: null, outcome: { acceptance: 'unknown' } })
    const completed = await input(session, 'unknown-run-first')
    expect(completed).toMatchObject({ status: 'handled' })
    expect((await session.execute('root.get', { agentKey: 'writer', rootId: completed.rootId! })).result)
      .toMatchObject({ outcome: 'completed', final: { text: 'fixed answer' } })
    await session.close('drain')
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    const current = await status(session)
    expect(current.instanceId).not.toBe(firstStatus.instanceId)
    expect(current.report.counts.pendingInputs).toBe(0)
    await expect(session.resume(original.id)).rejects.toMatchObject({ code: 'OPERATOR_INTENT_INVALID' })
    for (const key of ['unknown-run-second', 'unknown-run-third']) {
      expect(await session.submit({ agentKey: 'writer', submissionKey: key, text: key })).toMatchObject({ acceptance: 'accepted' })
      expect((await status(session)).report.counts.pendingInputs).toBe(1)
      const before = session.intents().length, runCount = fault.runReceipts.length
      const refused = await session.execute('host.run', { expectedInstanceId: current.instanceId })
      expect(refused).toMatchObject({ status: 'pending', acceptance: 'not-accepted', operationId: null,
        error: { code: 'OPERATOR_RUN_UNKNOWN_REQUIRED' } })
      expect(session.intents()).toHaveLength(before)
      expect(fault.runReceipts).toHaveLength(runCount)
      expect(await input(session, key)).toMatchObject({ status: 'queued', rootId: null })
      const acknowledged = await session.execute('host.run', { expectedInstanceId: current.instanceId }, { acknowledgeIntent: original.id })
      expect(acknowledged).toMatchObject({ status: 'ok', acceptance: 'accepted', result: { report: { businessRuns: 1 } } })
      expect(session.intents().at(-1)).toMatchObject({ id: acknowledged.operationId, method: 'host.run', parentIntent: null,
        acknowledgedIntent: original.id, acknowledgementReason: 'operator-requested-new-batch', outcome: { acceptance: 'accepted' } })
      expect(await input(session, key)).toMatchObject({ status: 'handled' })
      expect(session.intents().find(intent => intent.id === original.id)).toEqual(original)
    }
    expect(fault.runReceipts.map(receipt => receipt.report.businessRuns)).toEqual([1, 1, 1])
    expect((await agent(session)).report.counts).toMatchObject({ inputs: 3, roots: 3, modelUsage: 3 })
    expect((await status(session)).report.counts.pendingInputs).toBe(0)
    const facts = await inspectOperatorJournal(f.profile) as readonly OperatorFact[]
    expect(facts.filter(fact => fact.kind === 'prepared').map(fact => fact.intent)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: original.id, method: 'host.run', params: original.params, scope: original.scope }),
      expect.objectContaining({ method: 'host.run', acknowledgedIntent: original.id, acknowledgementReason: 'operator-requested-new-batch' }),
    ]))
    expect(facts.filter(fact => fact.kind === 'outcome' && fact.intentId === original.id)).toEqual([
      { kind: 'outcome', intentId: original.id, outcome: original.outcome },
    ])
    expect(facts.filter(fact => fact.kind === 'prepared').map(fact => fact.intent)
      .filter(intent => intent.acknowledgedIntent === original.id)).toMatchObject([
      { method: 'host.run', acknowledgedIntent: original.id, acknowledgementReason: 'operator-requested-new-batch',
        scope: { hostKey: original.scope.hostKey, instanceId: current.instanceId }, parentIntent: null },
      { method: 'host.run', acknowledgedIntent: original.id, acknowledgementReason: 'operator-requested-new-batch',
        scope: { hostKey: original.scope.hostKey, instanceId: current.instanceId }, parentIntent: null },
    ])
    expect(session.intents().filter(intent => intent.acknowledgedIntent === original.id)).toHaveLength(2)
  } finally { vi.restoreAllMocks(); await session.close('drain'); await rm(f.directory, { recursive: true, force: true }) }
})

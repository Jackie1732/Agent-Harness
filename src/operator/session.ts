import { randomUUID } from 'node:crypto'
import { EffectOwner } from '../effect/owner.js'
import { METHOD_CATEGORIES } from '../protocol/index.js'
import type { ControlMethod, Params, Result } from '../protocol/index.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonObject } from '../foundation/json.js'
import type { HostShutdownMode } from '../host/runtime.js'
import { readOperatorProfile } from './profile.js'
import { openOperatorConnection } from './connection.js'
import type { OperatorConnection } from './connection.js'
import { openOperatorJournal } from './intents.js'
import type { OperatorJournal } from './intents.js'
import { OperatorError, operatorFailure } from './errors.js'
import { operatorDigest, operatorOutcome, receiptOwnerSession } from './receipts.js'
import { operatorResult } from './result.js'
import type { OperatorSession, OperatorIntent, OperatorScope, OperatorCallOptions, OperatorResult, OperatorSubmit } from './types.js'
import { restoreOperatorInput } from './continuity.js'
import { requireOperatorReceiptRead } from './preflight.js'
import { readOperatorEventPage } from './event-pages.js'
import type { AnyControlOperation } from '../control/types.js'

/** Open one connection and one separately locked journal under their existing Effect owner. */
export async function openOperatorSession(profilePath: string, options: { readonly lifetime: 'command' | 'session';
  readonly environment?: Readonly<Record<string, string | undefined>> }): Promise<OperatorSession> {
  const loaded = await readOperatorProfile(profilePath), profile = loaded.profile
  const owner = new EffectOwner('operator-session')
  let connection: OperatorConnection | undefined, journal: OperatorJournal | undefined
  let stopping = false, readOnly = false, closing: Promise<void> | undefined
  let hostKey: string | null = null
  let requestedMode: HostShutdownMode = profile.connection.kind === 'local' ? profile.connection.shutdownMode : 'drain'
  const work = new Set<Promise<unknown>>()
  try {
    await owner.run('session-resources', async effect => {
      connection = await effect.apply('connection', () => openOperatorConnection(profile, options.environment ?? process.env), value => value.close(requestedMode))
      const status = await connection.request('host.status', {})
      hostKey = status.report.hostKey
      const bindingDigest = operatorDigest({ profileKey: profile.profileKey, kind: profile.connection.kind,
        hostKey: status.report.hostKey, location: profile.connection.kind === 'local' ? connection.spec!.storage.root : profile.connection.origin,
        callerNamespace: connection.callerNamespace, authentication: profile.connection.kind === 'remote' ? profile.connection.tlsFiles : null })
      const opened = await effect.apply('journal', () => openOperatorJournal(profile, bindingDigest, connection!.certificateFingerprint), value => value.dispose())
      journal = opened.journal
      readOnly = !journal.sameCertificate
      return undefined
    })
  } catch (error) {
    try { await owner.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Operator startup failed') }
    throw error
  }
  const link = connection!, log = journal!
  const emptyScope: OperatorScope = { connection: profile.connection.kind, connectionLifetime: options.lifetime,
    hostKey, instanceId: null, sessionId: null }
  const scopeFor = async <M extends ControlMethod>(method: M, params: Params<M>): Promise<OperatorScope> => {
    const status = await link.request('host.status', {})
    if (status.report.hostKey !== hostKey) { readOnly = true; throw new OperatorError('OPERATOR_BINDING_CHANGED', 2) }
    const target = params as { readonly agentKey?: string; readonly parentAgentKey?: string; readonly workflowKey?: string }
    const agentKey = target.agentKey ?? target.parentAgentKey
    let sessionId: string | null = null
    if (agentKey !== undefined) sessionId = (await link.request('agent.get', { agentKey })).sessionId
    else if (target.workflowKey !== undefined) sessionId = (await link.request('session.events', {
      target: { kind: 'workflow', workflowKey: target.workflowKey }, maxEvents: 1,
    })).sessionId
    if ('expectedInstanceId' in params && params.expectedInstanceId !== status.instanceId) throw new OperatorError('OPERATOR_INSTANCE_CHANGED', 3)
    if (method === 'host.run' && (status.activity !== 'idle' || status.hostStatus !== 'ready')) throw new OperatorError('OPERATOR_HOST_BUSY', 3)
    return { ...emptyScope, hostKey: status.report.hostKey, instanceId: status.instanceId, sessionId }
  }
  const execute = <M extends ControlMethod>(method: M, params: Params<M>, call: OperatorCallOptions = {}): Promise<OperatorResult> => {
    params = snapshotJson(params as JsonObject) as Params<M>
    call = { ...call }
    const task = (async (): Promise<OperatorResult> => {
      let scope = emptyScope, intent: OperatorIntent | undefined, actual: unknown = null
      try {
        if (call.signal?.aborted) throw new OperatorError('OPERATOR_ABORTED', 1)
        if (stopping || readOnly && METHOD_CATEGORIES[method] !== 'observation') throw new OperatorError('OPERATOR_CLOSING', 3)
        if (profile.connection.kind === 'local' && options.lifetime === 'command'
          && ['agent.pause', 'agent.resume', 'host.shutdown'].includes(method)) throw new OperatorError('OPERATOR_LOCAL_INSTANCE_COMMAND', 2)
        if (METHOD_CATEGORIES[method] !== 'observation') {
          scope = await scopeFor(method, params)
          const witnessedCaller = await requireOperatorReceiptRead(link, { method, params } as AnyControlOperation)
          if (call.parentIntent !== undefined) {
            const parent = log.get(call.parentIntent)
            if (parent === undefined || parent.method !== method || parent.scope.hostKey !== scope.hostKey
              || parent.scope.sessionId !== scope.sessionId || parent.certificateFingerprint !== link.certificateFingerprint) throw new OperatorError('OPERATOR_BINDING_CHANGED', 2)
            if (link.callerNamespace === null && witnessedCaller !== (parent.callerNamespace ?? parent.outcome?.summary.namespace)) throw new OperatorError('OPERATOR_CALLER_UNCONFIRMED', 3)
          }
          if (call.signal?.aborted) throw new OperatorError('OPERATOR_ABORTED', 1)
          if (method === 'host.run') {
            const unknown = log.intents.filter(item => item.method === 'host.run' && (item.outcome === null || item.outcome.acceptance === 'unknown')).at(-1)
            if (unknown !== undefined && call.acknowledgeIntent !== unknown.id) throw new OperatorError('OPERATOR_RUN_UNKNOWN_REQUIRED', 10)
            if (call.acknowledgeIntent !== undefined && (unknown === undefined || unknown.scope.hostKey !== scope.hostKey)) throw new OperatorError('OPERATOR_INTENT_INVALID', 2)
          }
          intent = await log.prepare({ method, params: params as JsonObject, scope, parentIntent: call.parentIntent ?? null,
            callerNamespace: link.callerNamespace ?? witnessedCaller, certificateFingerprint: link.certificateFingerprint, configDigest: operatorDigest(profile),
            acknowledgedIntent: call.acknowledgeIntent ?? null })
        }
        if (call.signal?.aborted) throw new OperatorError('OPERATOR_ABORTED', 1)
        actual = method === 'session.events'
          ? await readOperatorEventPage(link, profile, scope, params as Params<'session.events'>, call.signal)
          : await link.request(method, params, call.signal)
        let envelope = operatorResult(method, profile, scope, actual, intent?.id ?? null)
        if (intent !== undefined) {
          const messageRejected = (method === 'message.send' || method === 'message.reply') && (actual as Result<'message.send'>).status === 'not-accepted'
          const outcome = operatorOutcome(messageRejected ? 'not-accepted' : 'accepted', actual, null, method)
          if (messageRejected) envelope = { ...envelope, status: 'rejected', acceptance: 'not-accepted',
            error: { code: 'OPERATOR_MESSAGE_NOT_ACCEPTED', domainCode: null, message: 'Message command did not publish an outbox entry' } }
          if (method === 'input.submit' || method === 'input.answer') {
            const receipt = actual as Result<'input.submit'>, input = params as Params<'input.submit'>
            const observation = await link.request('input.get', { agentKey: input.agentKey, submissionKey: input.submissionKey }, call.signal)
            const current = await link.request('host.status', {}, call.signal)
            const same = current.report.hostKey === scope.hostKey && observation.sessionId === scope.sessionId && receipt.sessionId === scope.sessionId
              && observation.inputEventId === receipt.inputEventId && observation.submission?.key === input.submissionKey
              && (link.callerNamespace === null || observation.submission.namespace === link.callerNamespace)
              && (call.parentIntent === undefined || link.callerNamespace !== null
                || observation.submission?.namespace === (log.get(call.parentIntent)?.callerNamespace ?? log.get(call.parentIntent)?.outcome?.summary.namespace))
            const certified = { ...outcome, summary: { ...outcome.summary, submissionKey: input.submissionKey,
              namespace: observation.submission?.namespace ?? null } }
            await log.complete(intent.id, same ? certified : { ...certified, acceptance: 'unknown', errorCode: 'OPERATOR_SCOPE_CHANGED' })
            if (!same) { readOnly = true; envelope = { ...envelope, status: 'pending', error: { code: 'OPERATOR_SCOPE_CHANGED', domainCode: null, message: 'Accepted input target differs from the prepared target' } } }
          } else {
            const receiptSession = receiptOwnerSession(method, actual)
            const same = (actual as { readonly instanceId: string }).instanceId === scope.instanceId
              && (receiptSession === null || receiptSession === scope.sessionId)
            await log.complete(intent.id, same ? outcome : { ...outcome, acceptance: 'unknown', errorCode: 'OPERATOR_SCOPE_CHANGED' })
            if (!same) { readOnly = true; envelope = { ...envelope, status: 'pending', error: { code: 'OPERATOR_SCOPE_CHANGED', domainCode: null,
              message: 'Control receipt differs from its prepared instance or Session' } } }
          }
        }
        return envelope
      } catch (error) {
        if (intent !== undefined && log.get(intent.id)?.outcome === null && log.healthy) {
          try { await log.complete(intent.id, operatorOutcome(actual === null ? operatorFailure(error).acceptance : 'unknown', actual,
            operatorFailure(error).code, method)) }
          // Outcome append failure leaves the prepared record unknown; observations remain available.
          catch { readOnly = true }
        }
        if (actual !== null) {
          readOnly = true
          const envelope = operatorResult(method, profile, scope, actual, intent?.id ?? null)
          return { ...envelope, status: 'failed', error: { code: 'OPERATOR_RECORD_OR_VERIFY_FAILED', domainCode: null,
            message: 'Control returned; local recording or verification failed' } }
        }
        const failed = operatorResult(method, profile, scope, null, intent?.id ?? null, error)
        return METHOD_CATEGORIES[method] === 'observation' ? { ...failed, acceptance: 'not-applicable' }
          : intent === undefined ? { ...failed, acceptance: 'not-accepted' } : failed
      }
    })()
    work.add(task); void task.then(() => work.delete(task), () => work.delete(task))
    return task
  }
  const submit = async (input: OperatorSubmit): Promise<OperatorResult> => {
    input = { ...input }
    const submissionKey = input.submissionKey ?? randomUUID()
    const call = input.signal === undefined ? {} : { signal: input.signal }
    const receipt = input.wait === undefined ? await execute('input.submit', { agentKey: input.agentKey, text: input.text, submissionKey }, call)
      : await execute('input.answer', { agentKey: input.agentKey, text: input.text, submissionKey, wait: input.wait }, call)
    if (!input.drive) return receipt
    if (receipt.acceptance !== 'accepted' || receipt.status !== 'ok') return { ...receipt, result: {
      input: { intentId: receipt.operationId, acceptance: receipt.acceptance, result: receipt.result }, run: null } }
    let run: OperatorResult
    try {
      const status = await link.request('host.status', {}, input.signal)
      if (status.instanceId !== receipt.scope.instanceId) throw new OperatorError('OPERATOR_INSTANCE_CHANGED', 3)
      run = await execute('host.run', { expectedInstanceId: status.instanceId },
        { ...call, ...(input.acknowledgeIntent === undefined ? {} : { acknowledgeIntent: input.acknowledgeIntent }) })
    } catch (error) {
      const failure = operatorFailure(error)
      return { ...receipt, status: 'pending', error: { code: failure.code, domainCode: failure.domainCode, message: failure.message },
        result: { input: { intentId: receipt.operationId, acceptance: receipt.acceptance, result: receipt.result }, run: null } }
    }
    return { ...run, command: input.wait === undefined ? 'task.submit' : 'task.answer', result: {
      input: { intentId: receipt.operationId, acceptance: receipt.acceptance, result: receipt.result },
      run: { intentId: run.operationId, acceptance: run.acceptance, result: run.result },
    } }
  }
  const session: OperatorSession = { profile, execute, submit, intents: () => log.intents,
    checkpoint: (sessionId, sequence) => log.checkpoint(sessionId, sequence),
    eventCheckpoint: sessionId => log.eventCheckpoint(sessionId),
    resume: (id, options) => restoreOperatorInput(session, link, log, id, options?.signal),
    close(mode) {
      if (mode === 'cancel') requestedMode = 'cancel'
      if (closing !== undefined) { if (mode === 'cancel') void link.close('cancel'); return closing }
      stopping = true
      closing = (async () => {
        // Release/abort connection activity first; outstanding operations retain the journal until they settle.
        let failed: unknown
        try { await link.close(requestedMode) } catch (error) { failed = error }
        await Promise.allSettled(work)
        try { await owner.dispose() } catch (error) { throw new AggregateError(failed === undefined ? [error] : [failed, error], 'Operator release failed') }
        if (failed !== undefined) throw failed
      })()
      return closing
    } }
  return session
}

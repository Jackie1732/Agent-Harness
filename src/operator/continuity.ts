import type { Result, Params } from '../protocol/index.js'
import { ApiError } from '../client/errors.js'
import type { OperatorSession, OperatorResult } from './types.js'
import type { OperatorConnection } from './connection.js'
import type { OperatorJournal } from './intents.js'
import { OperatorError } from './errors.js'

/** Only original keyed input supports explicit replay; text similarity never certifies an operation. */
export async function restoreOperatorInput(session: OperatorSession, connection: OperatorConnection, journal: OperatorJournal,
  id: string, signal?: AbortSignal): Promise<OperatorResult> {
  if (signal?.aborted) throw new OperatorError('OPERATOR_ABORTED', 1)
  const intent = journal.get(id)
  if (intent === undefined || intent.method !== 'input.submit' && intent.method !== 'input.answer') throw new OperatorError('OPERATOR_INTENT_INVALID', 2)
  const status = await connection.request('host.status', {}, signal)
  const params = intent.params as unknown as Params<'input.submit'> | Params<'input.answer'>
  const agent = await connection.request('agent.get', { agentKey: params.agentKey }, signal)
  if (status.report.hostKey !== intent.scope.hostKey || agent.sessionId !== intent.scope.sessionId
    || connection.certificateFingerprint !== intent.certificateFingerprint) throw new OperatorError('OPERATOR_BINDING_CHANGED', 2)
  if (connection.callerNamespace !== null) {
    if (connection.callerNamespace !== intent.callerNamespace) throw new OperatorError('OPERATOR_BINDING_CHANGED', 2)
  } else {
    const priorNamespace = intent.callerNamespace ?? intent.outcome?.summary.namespace
    if (priorNamespace === null || priorNamespace === undefined) throw new OperatorError('OPERATOR_CALLER_UNCONFIRMED', 3)
    if (status.instanceId !== intent.scope.instanceId) {
      let witness: Result<'input.get'>
      try { witness = await connection.request('input.get', { agentKey: params.agentKey, submissionKey: params.submissionKey }, signal) }
      catch (error) {
        if (!(error instanceof ApiError)) throw error
        throw new OperatorError('OPERATOR_CALLER_UNCONFIRMED', 3)
      }
      if (witness.submission?.namespace !== priorNamespace) throw new OperatorError('OPERATOR_CALLER_UNCONFIRMED', 3)
    }
  }
  return intent.method === 'input.submit'
    ? session.execute('input.submit', params as Params<'input.submit'>, { parentIntent: id, ...(signal === undefined ? {} : { signal }) })
    : session.execute('input.answer', params as Params<'input.answer'>, { parentIntent: id, ...(signal === undefined ? {} : { signal }) })
}

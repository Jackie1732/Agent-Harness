import type { Params, SessionEventPage } from '../protocol/index.js'
import { sessionLogPosition } from '../session/ids.js'
import { displayValue } from '../tui/text.js'
import type { OperatorConnection } from './connection.js'
import type { ResolvedOperatorProfile } from './profile.js'
import type { OperatorScope } from './types.js'
import { OperatorError } from './errors.js'
import { operatorJson } from './cli-output.js'
import { operatorResult, operatorCloseFailure } from './result.js'

/** Read a real fixed-cut page within observation bytes and complete plain/JSONL outputs, including release failure. */
export async function readOperatorEventPage(connection: OperatorConnection, profile: ResolvedOperatorProfile,
  scope: OperatorScope, params: Params<'session.events'>, signal?: AbortSignal): Promise<SessionEventPage> {
  let query: Params<'session.events'> = { ...params, maxEvents: Math.min(params.maxEvents, profile.observation.maxPageEvents) }
  while (true) {
    const page = await connection.request('session.events', query, signal)
    const result = operatorResult('session.events', profile, scope, page)
    const outputs = [result, operatorCloseFailure(result, profile.connection.kind === 'local' ? 'cancel' : null)]
    const outputBytes = Math.max(...outputs.flatMap(value => [Buffer.byteLength(operatorJson(value)),
      Buffer.byteLength(displayValue(value, profile.display.maxTextBytes))])) + 1
    if (Buffer.byteLength(JSON.stringify(page)) <= profile.observation.maxPageBytes
      && outputBytes <= profile.output.maxBytes) return page
    if (page.events.length < 2) throw new OperatorError('OPERATOR_EVENT_PAGE_LIMIT', 1, 'not-applicable')
    query = { target: params.target, maxEvents: Math.floor(page.events.length / 2), cursor: {
      sessionId: page.sessionId, through: sessionLogPosition(page.through), nextSequence: page.events[0]!.sequence,
    } }
  }
}

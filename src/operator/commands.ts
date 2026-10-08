import { decodeParams } from '../protocol/index.js'
import type { ControlMethod, Params } from '../protocol/index.js'
import type { JsonValue } from '../foundation/json.js'
import type { OperatorSession, OperatorResult } from './types.js'
import type { OperatorArguments } from './cli-arguments.js'
import { requiredOption } from './cli-arguments.js'
import { OperatorError } from './errors.js'

/** Operator arguments project to the existing closed Control map; there is no second domain dispatcher. */
export async function executeOperatorCommand(session: OperatorSession, args: OperatorArguments,
  input: string | null, signal?: AbortSignal): Promise<OperatorResult> {
  const { command, options } = args, option = (key: string) => requiredOption(options, key)
  const call = signal === undefined ? {} : { signal }
  const acknowledgement = options.get('--acknowledge-intent') as string | undefined
  let result: OperatorResult
  switch (command) {
    case 'status': case 'connection.probe': result = await session.execute('host.status', {}, call); break
    case 'task.submit': result = await session.submit({ agentKey: option('--agent'), text: input ?? option('--text'),
      ...(options.has('--key') ? { submissionKey: option('--key') } : {}), drive: options.has('--drive'),
      ...call,
      ...(acknowledgement === undefined ? {} : { acknowledgeIntent: acknowledgement }) }); break
    case 'task.answer': {
      const params = operatorParams('input.answer', JSON.parse(input!))
      result = await session.submit({ ...params, drive: options.has('--drive'), ...call,
        ...(acknowledgement === undefined ? {} : { acknowledgeIntent: acknowledgement }) }); break
    }
    case 'task.get': result = await session.execute('input.get', operatorParams('input.get', { agentKey: option('--agent'),
      ...(options.has('--key') ? { submissionKey: option('--key') } : { inputEventId: option('--input-event') }) }), call); break
    case 'run-once': {
      const current = await session.execute('host.status', {}, call)
      if (current.status !== 'ok') return { ...current, command }
      const status = current.result as { readonly instanceId: string }
      result = await session.execute('host.run', { expectedInstanceId: status.instanceId }, { ...call,
        ...(acknowledgement === undefined ? {} : { acknowledgeIntent: acknowledgement }) }); break
    }
    case 'agent.pause': case 'agent.resume': case 'host.stop': {
      const current = await session.execute('host.status', {}, call)
      if (current.status !== 'ok') return { ...current, command }
      const status = current.result as { readonly instanceId: string }
      result = command === 'host.stop' ? await session.execute('host.shutdown', operatorParams('host.shutdown', { expectedInstanceId: status.instanceId, mode: option('--mode') }), call)
        : await session.execute(command, { expectedInstanceId: status.instanceId, agentKey: option('--agent') }, call); break
    }
    case 'intent.resume': result = await session.resume(option('--id'), call); break
    default: {
      const method = (command === 'events' ? 'session.events' : command.replace(/^child\./, 'delegation.')) as ControlMethod
      result = await session.execute(method, operatorParams(method, JSON.parse(input!)), call)
    }
  }
  return { ...result, command }
}

/** The JSON input boundary uses the same parameter validator as the SDK. */
export function operatorParams<M extends ControlMethod>(method: M, input: JsonValue): Params<M> {
  try { return decodeParams(method, input, { maxBytes: 2 * 1024 * 1024, maxDepth: 64, maxNodes: 100000 }) }
  catch { throw new OperatorError('OPERATOR_USAGE_PARAMS', 2) }
}

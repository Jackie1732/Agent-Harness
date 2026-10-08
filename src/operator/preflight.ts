import { randomUUID } from 'node:crypto'
import { parseMessageId } from '../communication/ids.js'
import { ApiError } from '../client/errors.js'
import type { AnyControlOperation } from '../control/types.js'
import type { OperatorConnection } from './connection.js'

/** Require the matching read grant before a new mutation; an authorized absent reference proves only that grant. */
export async function requireOperatorReceiptRead(connection: OperatorConnection, operation: AnyControlOperation): Promise<string | null> {
  const { method, params } = operation
  try {
    switch (method) {
      case 'input.submit': case 'input.answer':
        return (await connection.request('input.get', { agentKey: params.agentKey, submissionKey: params.submissionKey })).submission?.namespace ?? null
      case 'message.send':
        await connection.request('message.get', { agentKey: params.agentKey, direction: 'outbox', messageId: parseMessageId(randomUUID()) }); break
      case 'message.reply':
        await connection.request('message.get', { agentKey: params.agentKey, direction: 'inbox', messageId: params.messageId }); break
      case 'delegation.spawn':
        await connection.request('delegation.get', { parentAgentKey: params.parentAgentKey, parentRoot: params.parentRoot, delegationId: params.parentRoot }); break
      case 'delegation.cancel':
        await connection.request('delegation.get', { parentAgentKey: params.parentAgentKey, parentRoot: params.parentRoot, delegationId: params.delegationId }); break
      case 'root.cancel': await connection.request('root.get', { agentKey: params.agentKey, rootId: params.rootId }); break
      case 'workflow.pause': case 'workflow.resume': case 'workflow.cancel': case 'workflow.retry':
        await connection.request('workflow.get', { workflowKey: params.workflowKey }); break
      default: break
    }
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'API_TARGET_NOT_FOUND' || error.acceptance !== 'not-applicable') throw error
  }
  return null
}

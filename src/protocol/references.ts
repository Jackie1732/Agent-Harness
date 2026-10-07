import type { Brand } from '../foundation/brand.js'
import { brand } from '../foundation/brand.js'
import type { SessionEventId, SessionId, SessionLogPosition } from '../session/ids.js'
import { ProtocolError } from './errors.js'

/** Opaque identity of one transport attempt; it has no durable deduplication meaning. */
export type RequestId = Brand<string, 'ControlRequestId'>
export function parseRequestId(value: string): RequestId {
  if (!/^[\x21-\x7e]{1,128}$/.test(value)) throw new ProtocolError('API_PROTOCOL_INVALID')
  return brand<string, 'ControlRequestId'>(value)
}

/** A fixed local prefix; continuation never incorporates later appends. */
export interface SessionEventCursor {
  readonly sessionId: SessionId
  readonly through: SessionLogPosition
  readonly nextSequence: number
}
export type SessionTarget =
  | { readonly kind: 'member'; readonly agentKey: string }
  | { readonly kind: 'child'; readonly parentAgentKey: string; readonly parentRoot: SessionEventId; readonly delegationId: SessionEventId }
  | { readonly kind: 'workflow'; readonly workflowKey: string }
export interface InputSubmission { readonly namespace: string; readonly key: string }

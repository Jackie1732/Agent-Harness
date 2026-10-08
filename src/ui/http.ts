import type { IncomingMessage, ServerResponse } from 'node:http'
import { ApiError, ClientAbortError, ClientTransportError } from '../client/errors.js'
import { ApiRejection } from '../api/errors.js'
import { METHOD_CATEGORIES, ProtocolError } from '../protocol/index.js'
import type { ControlMethod } from '../protocol/index.js'
import { inspectBoundedJson } from '../schema/bounded-json.js'
import { writeResponse } from '../api/http-io.js'
import type { ResolvedUiConfig } from './config.js'

/** Local browser rejections carry no caller input, paths or underlying exception. */
export class UiRejection extends Error {
  constructor(readonly code: 'UI_UNAUTHORIZED' | 'UI_ORIGIN_INVALID' | 'UI_PROTOCOL_INVALID' | 'UI_LIMIT_EXCEEDED' | 'UI_CAPACITY_EXCEEDED' | 'UI_INACTIVE', readonly status: number) { super('Browser request rejected') }
}
/** Exact loopback authority prevents alternate Host headers from addressing the privileged gateway. */
export function authorizeOrigin(request: IncomingMessage, origin: string): void {
  if (request.headers.host !== new URL(origin).host || request.method === 'POST' && request.headers.origin !== origin) throw new UiRejection('UI_ORIGIN_INVALID', 403)
}
/** Preserve confirmed or unknown remote acceptance; gateway failures never repeat a mutation. */
export function browserFailure(error: unknown, method?: ControlMethod, domainReturned = false) {
  const localAcceptance = method !== undefined && METHOD_CATEGORIES[method] === 'observation' ? 'not-applicable' : domainReturned ? 'unknown' : 'not-accepted'
  if (error instanceof ApiError) return { status: 200, error: { code: error.code, message: error.message, acceptance: error.acceptance, domainCode: error.domainCode } }
  if (error instanceof ClientTransportError || error instanceof ClientAbortError) return { status: 200,
    error: { code: error instanceof ClientAbortError ? 'CLIENT_ABORTED' : 'CLIENT_TRANSPORT_ERROR', message: 'No validated remote receipt', acceptance: error.acceptance, domainCode: null } }
  if (error instanceof UiRejection) return { status: error.status, error: { code: error.code, message: error.message, acceptance: localAcceptance, domainCode: null } }
  if (error instanceof ApiRejection || error instanceof ProtocolError) return { status: error.code === 'API_LIMIT_EXCEEDED' ? 413 : 400,
    error: { code: error.code === 'API_LIMIT_EXCEEDED' ? 'UI_LIMIT_EXCEEDED' : 'UI_PROTOCOL_INVALID', message: 'Browser data rejected', acceptance: localAcceptance, domainCode: null } }
  return { status: 500, error: { code: 'UI_INTERNAL_ERROR', message: 'Browser gateway failed', acceptance: localAcceptance, domainCode: null } }
}
/** Bounded JSON output uses the SDK response budget and the existing write deadline owner. */
export async function writeBrowserJson(response: ServerResponse, config: ResolvedUiConfig, status: number, value: unknown): Promise<void> {
  inspectBoundedJson(value, { maxBytes: config.remote.limits.maxResponseBytes, maxDepth: config.remote.limits.maxJsonDepth, maxNodes: config.remote.limits.maxJsonNodes })
  await writeResponse(response, status, Buffer.from(JSON.stringify(value)), config.limits.responseWriteTimeoutMs)
}

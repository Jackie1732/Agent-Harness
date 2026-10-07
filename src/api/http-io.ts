import type { IncomingMessage, ServerResponse } from 'node:http'
import { JsonBoundaryError, parseBoundedJson } from '../schema/bounded-json.js'
import type { ApiLimits } from './config.js'
import { ApiRejection } from './errors.js'

/** Bound body allocation and read duration before protocol decoding. */
export function readRequest(request: IncomingMessage, limits: ApiLimits): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, settled = false
    const timer = setTimeout(() => done(new ApiRejection('API_LIMIT_EXCEEDED')), limits.requestReadTimeoutMs)
    const data = (chunk: Buffer): void => {
      size += chunk.byteLength
      if (size > limits.maxRequestBytes) done(new ApiRejection('API_LIMIT_EXCEEDED'))
      else chunks.push(chunk)
    }
    const failed = (): void => done(new ApiRejection('API_PROTOCOL_INVALID'))
    const end = (): void => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
        const result = parseBoundedJson(text, { maxBytes: limits.maxRequestBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes })
        done(undefined, result)
      } catch (error) { done(new ApiRejection(error instanceof JsonBoundaryError && error.reason !== 'invalid' ? 'API_LIMIT_EXCEEDED' : 'API_PROTOCOL_INVALID')) }
    }
    function done(error?: Error, value?: unknown): void {
      if (settled) return
      settled = true; clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', failed)
      if (error === undefined) resolve(value)
      else { request.resume(); reject(error) }
    }
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', failed)
  })
}
/** One complete JSON response; slow or abandoned output never repeats the domain operation. */
export function writeResponse(response: ServerResponse, status: number, body: Buffer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(new Error('Control response write expired')), timeoutMs)
    const closed = (): void => finish(response.writableFinished ? undefined : new Error('Control response disconnected'))
    const failed = (): void => finish(new Error('Control response failed'))
    const complete = (): void => finish()
    function finish(error?: Error): void {
      if (settled) return
      settled = true; clearTimeout(timer); response.off('close', closed); response.off('error', failed); response.off('finish', complete)
      if (error === undefined) resolve()
      else { response.destroy(); reject(error) }
    }
    response.once('close', closed); response.once('error', failed); response.once('finish', complete)
    if (response.destroyed) { finish(new Error('Control response disconnected')); return }
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.byteLength })
    response.end(body)
  })
}

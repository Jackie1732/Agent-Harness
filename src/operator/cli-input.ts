import type { Readable } from 'node:stream'
import { parseBoundedJson } from '../schema/bounded-json.js'
import type { JsonValue } from '../foundation/json.js'
import { OperatorError } from './errors.js'

/** Read one finite stdin document; its bytes are never treated as a shell expression. */
export async function readOperatorInput(input: Readable, signal?: AbortSignal): Promise<string> {
  const maxBytes = 2 * 1024 * 1024, chunks: Buffer[] = []
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    const paused = input.isPaused()
    const finish = (error?: Error) => {
      input.off('data', data); input.off('end', end); input.off('error', failure); input.off('close', close)
      signal?.removeEventListener('abort', abort)
      if (paused) input.pause()
      if (error === undefined) resolve(); else reject(error)
    }
    const data = (chunk: Buffer | string) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += part.length
      if (bytes > maxBytes) finish(new OperatorError('OPERATOR_USAGE_INPUT_BUDGET', 2)); else chunks.push(part)
    }
    const end = () => finish(), close = () => finish(new OperatorError('OPERATOR_INPUT_CLOSED', 1))
    const failure = () => finish(new OperatorError('OPERATOR_INPUT_FAILED', 1))
    const abort = () => finish(new OperatorError('OPERATOR_ABORTED', 1))
    if (signal?.aborted) { abort(); return }
    if (input.readableEnded) { end(); return }
    input.on('data', data); input.once('end', end); input.once('error', failure); input.once('close', close)
    signal?.addEventListener('abort', abort, { once: true }); input.resume()
  })
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)) }
  catch { throw new OperatorError('OPERATOR_USAGE_UTF8', 2) }
}
export function parseOperatorInput(source: string): JsonValue {
  try { return parseBoundedJson(source, { maxBytes: 2 * 1024 * 1024, maxDepth: 64, maxNodes: 100000 }) }
  catch { throw new OperatorError('OPERATOR_USAGE_JSON', 2) }
}

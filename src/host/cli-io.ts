import type { Readable, Writable } from 'node:stream'
import { parseBoundedJson } from '../schema/bounded-json.js'
import { HostError } from './errors.js'

/** Segment chunks before copying; an oversized line is discarded through its next delimiter. */
export async function* boundedJsonLines(input: Readable, maximumLineBytes: number,
  options: { readonly recover?: boolean } = {}): AsyncGenerator<unknown> {
  let parts: Buffer[] = []
  let length = 0
  let oversized = false
  const decode = (bytes: Buffer): unknown => {
    try {
      return parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        { maxBytes: maximumLineBytes, maxDepth: 32, maxNodes: 10000 })
    } catch { return new HostError('HOST_PROTOCOL_INVALID', 'cli-line-invalid-json') }
  }
  const result = (value: unknown): unknown => {
    if (value instanceof HostError && !options.recover) throw value
    return value
  }
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    let offset = 0
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset)
      const end = newline < 0 ? bytes.length : newline
      const segment = bytes.subarray(offset, end)
      length += segment.length
      if (length > maximumLineBytes) { oversized = true; parts = [] }
      else if (!oversized) parts.push(segment)
      if (newline < 0) break
      if (oversized) yield result(new HostError('HOST_PROTOCOL_INVALID', 'cli-line-too-large'))
      else if (length > 0) yield result(decode(Buffer.concat(parts, length)))
      parts = []; length = 0; oversized = false; offset = newline + 1
    }
  }
  if (oversized) yield result(new HostError('HOST_PROTOCOL_INVALID', 'cli-line-too-large'))
  else if (length > 0) yield result(decode(Buffer.concat(parts, length)))
}

/** Bound queued bytes, serialize writes and wait for actual stream callbacks. */
export function createJsonLineWriter(output: Writable, maximumBytes: number, drainTimeoutMs = 30_000) {
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1) throw new RangeError('drainTimeoutMs must be positive')
  let queued = 0
  let tail: Promise<void> = Promise.resolve()
  let failure: Error | undefined
  const failed = (error: Error): void => { failure ??= error }
  output.on('error', failed)
  const write = (value: unknown): Promise<void> => {
    const line = `${JSON.stringify(value)}\n`
    const bytes = Buffer.byteLength(line)
    if (queued + bytes > maximumBytes) return Promise.reject(new HostError('HOST_OUTPUT_FAILED', 'cli-output-budget'))
    queued += bytes
    const task = tail.then(() => new Promise<void>((resolve, reject) => {
      if (failure !== undefined || output.destroyed) { reject(new HostError('HOST_OUTPUT_FAILED', 'cli-output-closed')); return }
      let settled = false
      const finish = (error?: Error | null): void => {
        if (settled) return
        settled = true; clearTimeout(timer); output.off('close', closed); output.off('error', errored)
        if (error !== undefined && error !== null) reject(new HostError('HOST_OUTPUT_FAILED', 'cli-output-failed'))
        else resolve()
      }
      const closed = (): void => finish(new Error('closed'))
      const errored = (error: Error): void => finish(error)
      const timer = setTimeout(() => finish(new Error('timeout')), Math.min(drainTimeoutMs, 2_147_483_647))
      output.once('close', closed); output.once('error', errored)
      try { output.write(line, finish) } catch (error) { finish(error instanceof Error ? error : new Error('write')) }
    })).finally(() => { queued -= bytes })
    tail = task
    void task.catch(() => undefined)
    return task
  }
  return Object.assign(write, { async dispose() {
    // Stream destruction queues error emission after the write callback's rejection.
    await new Promise<void>(resolve => setImmediate(resolve))
    output.off('error', failed)
  } })
}

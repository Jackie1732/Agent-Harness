import type { Readable, Writable } from 'node:stream'
import { HostError } from './errors.js'

/** Decode bounded UTF-8 JSON Lines without allowing an unterminated line to grow indefinitely. */
export async function* boundedJsonLines(input: Readable, maximumLineBytes: number): AsyncGenerator<unknown> {
  let pending = Buffer.alloc(0)
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    pending = Buffer.concat([pending, bytes])
    while (true) {
      const newline = pending.indexOf(0x0a)
      if (newline < 0) break
      const line = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      if (line.byteLength > maximumLineBytes) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-line-too-large')
      const normalized = line.at(-1) === 0x0d ? line.subarray(0, -1) : line
      if (normalized.byteLength === 0) continue
      try { yield JSON.parse(normalized.toString('utf8')) }
      catch { throw new HostError('HOST_PROTOCOL_INVALID', 'cli-line-invalid-json') }
    }
    if (pending.byteLength > maximumLineBytes) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-line-too-large')
  }
  if (pending.byteLength > 0) {
    if (pending.byteLength > maximumLineBytes) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-line-too-large')
    try { yield JSON.parse(pending.toString('utf8')) }
    catch { throw new HostError('HOST_PROTOCOL_INVALID', 'cli-line-invalid-json') }
  }
}

/** Bounded JSONL writer that respects stream backpressure. */
export function createJsonLineWriter(output: Writable, maximumBytes: number, drainTimeoutMs = 30_000) {
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1) throw new RangeError('drainTimeoutMs must be positive')
  let written = 0
  return async (value: unknown): Promise<void> => {
    const line = `${JSON.stringify(value)}\n`
    written += Buffer.byteLength(line)
    if (written > maximumBytes) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-output-budget')
    if (!output.write(line)) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => failed(new HostError('HOST_PROTOCOL_INVALID', 'cli-output-drain-timeout')), drainTimeoutMs)
      const cleanup = (): void => { clearTimeout(timer); output.off('drain', drained); output.off('error', failed) }
      const drained = (): void => { cleanup(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      output.once('drain', drained); output.once('error', failed)
    })
  }
}

import { TextDecoder } from 'node:util'
import type { ModelStreamLimits } from '../../contract.js'
import { ModelError } from '../../errors.js'

/** One SSE dispatch, including empty/comment records for resource accounting. */
export interface SseRecord {
  readonly event: string
  readonly data: string
}

/** Pull-based UTF-8/SSE framing; no unbounded queue and no transport ownership. */
export async function* readServerSentEvents(
  source: AsyncIterable<Uint8Array>, limits: ModelStreamLimits,
): AsyncGenerator<SseRecord> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let line = ''
  let event = ''
  let data: string[] = []
  let recordBytes = 0
  let streamBytes = 0
  let records = 0
  let afterCr = false
  const acceptLine = (): SseRecord | undefined => {
    const current = line
    line = ''
    if (current.length === 0) {
      records += 1
      if (records > limits.maxFrames) throw limit()
      const record = { event, data: data.join('\n') }
      event = ''
      data = []
      recordBytes = 0
      return record
    }
    if (current.startsWith(':')) return undefined
    const separator = current.indexOf(':')
    const name = separator < 0 ? current : current.slice(0, separator)
    let value = separator < 0 ? '' : current.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (name === 'data') data.push(value)
    else if (name === 'event') event = value
    // SSE id/retry are transport metadata, not automatic reconnect instructions.
    else if (name !== 'id' && name !== 'retry') throw invalid('unsupported SSE field')
    return undefined
  }
  const characters = function* (decoded: string): Generator<SseRecord> {
    for (const char of decoded) {
      if (afterCr && char === '\n') { afterCr = false; continue }
      afterCr = false
      recordBytes += Buffer.byteLength(char)
      if (recordBytes > limits.maxFrameBytes) throw limit()
      if (char === '\r' || char === '\n') {
        afterCr = char === '\r'
        const record = acceptLine()
        if (record !== undefined) yield record
      } else line += char
    }
  }
  try {
    for await (const bytes of source) {
      streamBytes += bytes.byteLength
      if (streamBytes > limits.maxStreamBytes) throw limit()
      yield* characters(decoder.decode(bytes, { stream: true }))
    }
    yield* characters(decoder.decode())
  } catch (cause) {
    if (cause instanceof ModelError) throw cause
    // Never echo parser input or Node request errors containing credentials.
    throw invalid('model stream is invalid UTF-8 or transport ended unexpectedly')
  }
  if (line.length > 0 || data.length > 0 || event.length > 0) throw invalid('SSE stream ends inside an event')
}

function invalid(message: string): ModelError { return new ModelError('MODEL_PROTOCOL_INVALID', message) }
function limit(): ModelError { return new ModelError('MODEL_LIMIT_EXCEEDED', 'SSE stream exceeds its explicit receive budget') }

import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { once } from 'node:events'
import { createDurableEventCatalog } from '../../src/session/event-catalog.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import type { SessionBackend } from '../../src/session/backend.js'
import { modelSessionEventDefinitions } from '../../src/model/session-events.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ScriptedModelProviderOptions } from '../../src/model/providers/scripted.js'
import type { ModelFrame, ModelRequest, ModelRunnerLimits, ModelStreamLimits } from '../../src/model/contract.js'

export type RegisterCase = (name: string, run: () => void | Promise<void>) => unknown
export const runnerLimits: ModelRunnerLimits = Object.freeze({ maxInputBytes: 32768, maxNormalizedResultBytes: 8192, maxOutputBlocks: 16, maxToolCalls: 8, maxJournalConflicts: 8 })
export const streamLimits: ModelStreamLimits = Object.freeze({ maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 })
export const tool = { name: 'lookup', description: 'Look up an item', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } as const
export const request = (): ModelRequest => ({ model: 'fixture-model', instructions: ['Be exact.'], messages: [{ role: 'user', content: [{ kind: 'text', text: '你好' }] }], tools: [], maxOutputTokens: 64 })
import { createDeferred } from '../helpers/deferred.js'
export const deferred = createDeferred<void>
export function repository(backend: SessionBackend = new MemorySessionBackend({ maxRecordBytes: 65536 })) {
  return new SessionRepository({ backend, catalog: createDurableEventCatalog(modelSessionEventDefinitions), maxLineageDepth: 4 })
}
export async function* textFrames(text = 'hello 世界'): AsyncGenerator<ModelFrame> {
  yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'response-1' }
  yield { kind: 'block-start', index: 0, block: 'text' }
  yield { kind: 'text-delta', index: 0, text }
  yield { kind: 'block-end', index: 0 }
  yield { kind: 'usage', counts: { inputTokens: 0, outputTokens: 4 } }
  yield { kind: 'complete', stopReason: 'stop' }
}
export function scripted(options: Partial<ScriptedModelProviderOptions> = {}) {
  return new ScriptedModelProvider({ providerId: 'scripted', maxConcurrentExchanges: 1, streamLimits, script: () => textFrames(), ...options })
}
export function hasCode(code: string) {
  return (cause: unknown): boolean => { assert.ok(cause instanceof Error && 'code' in cause); assert.equal(cause.code, code); return true }
}

/** Loopback-only HTTP fixture; captures actual adapter bytes and never contacts a vendor. */
export async function httpFixture(respond: (response: ServerResponse, count: number) => void) {
  const requests: { body: Buffer; headers: Record<string, string | string[] | undefined> }[] = []
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    requests.push({ body: Buffer.concat(chunks), headers: incoming.headers })
    respond(response, requests.length)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  return {
    endpoint: `http://127.0.0.1:${address.port}/model`, requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}
export const sse = (event: string, value: unknown): string => `${event ? `event: ${event}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
export function deepSeekText(text = '你好') {
  const chunk = (delta: object, finish: string | null, usage?: object) => sse('', { id: 'ds-1', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })
  return chunk({ role: 'assistant', content: '' }, null) + chunk({ content: text }, 'stop', { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }) + sse('', '[DONE]')
}
export function anthropicText(text = '你好') {
  return sse('message_start', { type: 'message_start', message: { type: 'message', id: 'an-1', role: 'assistant', content: [], model: 'fixture-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } } })
    + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + sse('ping', { type: 'ping' })
    + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    + sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    + sse('message_stop', { type: 'message_stop' })
}

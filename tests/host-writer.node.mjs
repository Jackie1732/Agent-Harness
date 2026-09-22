import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { test } from 'node:test'
import { createJsonLineWriter } from '../dist/host/index.js'

const turn = () => new Promise(resolve => setImmediate(resolve))

test('Writer closes admission synchronously and joins both backpressured accepted writes', async () => {
  const callbacks = []
  const chunks = []
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callbacks.push(callback) } })
  const writer = createJsonLineWriter(output, 128)
  const first = writer({ first: true }); const second = writer({ second: true })
  const disposal = writer.dispose()
  assert.equal(writer.dispose(), disposal)
  let settled = false
  void disposal.then(() => { settled = true })
  await assert.rejects(writer({ late: true }), { code: 'HOST_OUTPUT_FAILED' })
  await turn(); assert.equal(settled, false); assert.equal(chunks.length, 1)
  callbacks.shift()(); await first; await turn()
  assert.equal(settled, false); assert.equal(chunks.length, 2)
  callbacks.shift()(); await second; await disposal
  assert.equal(output.destroyed, false); assert.equal(output.writableEnded, false)
  assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0)
})

test('Writer joins EPIPE failure and removes listeners after Node emits the stream error', async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { setImmediate(() => callback(Object.assign(new Error('pipe'), { code: 'EPIPE' }))) } })
  const writer = createJsonLineWriter(output, 128)
  const written = writer({ record: 1 }); const disposal = writer.dispose()
  await assert.rejects(written, { code: 'HOST_OUTPUT_FAILED' })
  await assert.rejects(disposal, { code: 'HOST_OUTPUT_FAILED' }); await turn()
  assert.equal(output.listenerCount('error'), 0)
})

test('a successful earlier callback cannot detach the listener of a queued write during disposal', async () => {
  const callbacks = []
  const output = new Writable({ write(_chunk, _encoding, callback) { callbacks.push(callback) } })
  const writer = createJsonLineWriter(output, 128)
  const first = writer(1); const second = writer(2); const disposal = writer.dispose()
  await turn(); callbacks.shift()(); await first; await turn(); await turn()
  assert.ok(output.listenerCount('error') > 0)
  callbacks.shift()(Object.assign(new Error('second pipe'), { code: 'EPIPE' }))
  await assert.rejects(second, { code: 'HOST_OUTPUT_FAILED' })
  await assert.rejects(disposal, { code: 'HOST_OUTPUT_FAILED' }); await turn()
  assert.equal(output.listenerCount('error'), 0)
})

for (const order of ['close-error', 'error-close']) test(`Writer handles ${order} during disposal`, async () => {
  let callback
  const output = new Writable({ autoDestroy: false, write(_chunk, _encoding, done) { callback = done } })
  const writer = createJsonLineWriter(output, 128)
  const written = writer({ record: 1 }); const disposal = writer.dispose()
  await turn()
  for (const event of order.split('-')) output.emit(event, new Error('closed pipe'))
  await assert.rejects(written, { code: 'HOST_OUTPUT_FAILED' })
  await assert.rejects(disposal, { code: 'HOST_OUTPUT_FAILED' })
  callback(); await turn()
  assert.equal(output.listenerCount('error'), 0)
  assert.equal(output.destroyed, false)
})

test('Writer timeout retains an owner for late errors and rejects queued work without writing it', async () => {
  let callback
  let writes = 0
  const output = new Writable({ autoDestroy: false, write(_chunk, _encoding, done) { writes++; callback = done } })
  const writer = createJsonLineWriter(output, 128, 10)
  const first = writer({ record: 1 }); const second = writer({ record: 2 })
  const disposal = writer.dispose()
  await assert.rejects(first, { code: 'HOST_OUTPUT_FAILED' })
  await assert.rejects(second, { code: 'HOST_OUTPUT_FAILED' })
  await assert.rejects(disposal, { code: 'HOST_OUTPUT_FAILED' })
  assert.equal(writes, 1); assert.equal(output.destroyed, false)
  assert.equal(output.listenerCount('error'), 1)
  callback(Object.assign(new Error('late error'), { code: 'EPIPE' }))
  await turn(); await turn()
  assert.equal(output.listenerCount('error'), 0)
  assert.equal(writer.dispose(), disposal)
  await assert.rejects(writer({ late: true }), { code: 'HOST_OUTPUT_FAILED' })
})

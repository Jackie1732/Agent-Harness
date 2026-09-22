import { PassThrough, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { boundedJsonLines, createJsonLineWriter } from '../../src/host/cli-io.js'

it('bounds queued output rather than the lifetime size of a long-lived service', async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const write = createJsonLineWriter(output, 32)
  try { for (let index = 0; index < 100; index++) await write({ index }) }
  finally { await write.dispose() }
})

it('handles asynchronous EPIPE without an unhandled stream error', async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { queueMicrotask(() => callback(Object.assign(new Error('private path'), { code: 'EPIPE' }))) } })
  const write = createJsonLineWriter(output, 128)
  try { await expect(write({ accepted: 'already committed' })).rejects.toMatchObject({ code: 'HOST_OUTPUT_FAILED' }) }
  finally { await expect(write.dispose()).rejects.toMatchObject({ code: 'HOST_OUTPUT_FAILED' }) }
})

it('rejects malformed UTF-8 and deep JSON while continuing at the next line', async () => {
  const input = new PassThrough()
  const records: unknown[] = []
  const reading = (async () => { for await (const record of boundedJsonLines(input, 128, { recover: true })) records.push(record) })()
  input.end(Buffer.concat([Buffer.from([0x22, 0xff, 0x22, 0x0a]), Buffer.from('['.repeat(40) + '0' + ']'.repeat(40) + '\n{"ok":true}')]))
  await reading
  expect(records).toMatchObject([{ code: 'HOST_PROTOCOL_INVALID' }, { code: 'HOST_PROTOCOL_INVALID' }, { ok: true }])
})

import { expect, it } from 'vitest'
import { encodeFrame, FrameScanner } from '../../src/session/frame.js'

it.each([1, 127, 65_536])('reads mixed frames and exact offsets from %i-byte chunks', width => {
  const payloads = [Buffer.from('{"text":"帧👩‍🔬"}'), Buffer.from('x'.repeat(150_000)), Buffer.from('{}')]
  const frames = payloads.map(payload => Buffer.from(encodeFrame(payload, 200_000)))
  const stream = Buffer.concat(frames)
  const scanner = new FrameScanner(200_000)
  const decoded = []
  for (let index = 0; index < stream.length; index += width) decoded.push(...scanner.push(stream.subarray(index, index + width)))
  expect(decoded.map(frame => Buffer.from(frame.payload))).toEqual(payloads)
  let offset = 0
  expect(decoded.map(frame => [frame.offset, frame.endOffset])).toEqual(frames.map(frame => {
    const start = offset
    offset += frame.length
    return [start, offset]
  }))
  expect(scanner.finish(false)).toEqual({ byteLength: stream.length })
})

it('keeps unconsumed frames and a legal partial tail across limited empty pushes', () => {
  const payloads = [Buffer.from('first'), Buffer.from('second'), Buffer.from('third')]
  const frames = payloads.map(payload => Buffer.from(encodeFrame(payload, 1024)))
  const partial = Buffer.from(encodeFrame(Buffer.from('unfinished'), 1024)).subarray(0, 9)
  const scanner = new FrameScanner(1024)
  const stream = Buffer.concat([...frames, partial])
  expect(scanner.push(stream, 0)).toEqual([])
  const decoded = []
  for (let index = 0; index < frames.length; index++) decoded.push(...scanner.push(new Uint8Array(), 1))
  expect(decoded.map(frame => Buffer.from(frame.payload))).toEqual(payloads)
  expect(scanner.push(new Uint8Array())).toEqual([])
  expect(scanner.finish(true)).toEqual({ byteLength: stream.length - partial.length,
    incompleteTail: { byteOffset: stream.length - partial.length, byteLength: partial.length } })
})

it('owns pending input bytes and returns payloads independent of later frames', () => {
  const payload = Buffer.from('snapshot 帧')
  const frame = Buffer.from(encodeFrame(payload, 1024))
  const prefix = Buffer.from(frame.subarray(0, frame.length - 1))
  const scanner = new FrameScanner(1024)
  expect(scanner.push(prefix)).toEqual([])
  prefix.fill(0)
  const [decoded] = scanner.push(frame.subarray(frame.length - 1))
  expect(Buffer.from(decoded!.payload)).toEqual(payload)
  const next = encodeFrame(Buffer.from('later'.repeat(100)), 1024)
  scanner.push(next)
  expect(Buffer.from(decoded!.payload)).toEqual(payload)
  expect(scanner.finish(false)).toEqual({ byteLength: frame.length + next.length })
})

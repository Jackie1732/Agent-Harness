import { expect, it } from 'vitest'
import { HostBusinessLane } from '../../src/host/business-lane.js'

it('drains admitted readers before an exclusive candidate and prevents readers overtaking it', () => {
  const lane = new HostBusinessLane(2, {})
  expect(lane.admit('first', 'readonly')).toBe(true)
  expect(lane.admit('second', 'readonly')).toBe(true)
  expect(lane.admit('writer', 'exclusive')).toBe(false)
  lane.release('first')
  expect(lane.admit('third', 'readonly')).toBe(false)
  expect(lane.admit('writer', 'exclusive')).toBe(false)
  lane.release('second')
  expect(lane.admit('writer', 'exclusive')).toBe(true)
  expect(lane.admit('third', 'readonly')).toBe(false)
  lane.release('writer')
  expect(lane.admit('third', 'readonly')).toBe(true)
})

it('retains an exclusive position across finite runs and releases it when the candidate is paused', () => {
  const cursor = {}
  const first = new HostBusinessLane(2, cursor)
  first.admit('reader', 'readonly')
  expect(first.admit('writer', 'exclusive')).toBe(false)
  first.release('reader')
  const second = new HostBusinessLane(2, cursor)
  expect(second.admit('reader', 'readonly')).toBe(false)
  second.retainExclusive(() => false)
  expect(second.admit('reader', 'readonly')).toBe(true)
})

it('keeps capacity one and duplicate Agent admission serial', () => {
  const lane = new HostBusinessLane(1, {})
  expect(lane.admit('reader', 'readonly')).toBe(true)
  expect(lane.admit('reader', 'readonly')).toBe(false)
  expect(lane.admit('other', 'readonly')).toBe(false)
  lane.release('reader')
  expect(lane.admit('other', 'readonly')).toBe(true)
})

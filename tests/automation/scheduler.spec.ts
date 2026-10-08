import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextAutomationTick, startAutomationSchedule } from '../../src/automation/scheduler.js'

afterEach(() => vi.useRealTimers())
describe('UTC interval scheduling', () => {
  it('starts strictly in the future even at an exact tick or after many missed ticks', () => {
    expect(nextAutomationTick(1000, 100, 900)).toBe(0)
    expect(nextAutomationTick(1000, 100, 1000)).toBe(1)
    expect(nextAutomationTick(1000, 100, 1571)).toBe(6)
  })
  it('takes only the latest due tick and retains UTC identity after a delayed wake', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    let clock = 1000
    const events: string[] = [], errors: unknown[] = []
    const schedule = startAutomationSchedule({ jobKey: 'periodic', agentKey: 'writer', trigger: { kind: 'interval', anchor: new Date(1000).toISOString(), intervalMs: 100, text: 'review' } },
      async id => { events.push(id) }, () => clock, error => errors.push(error))
    clock = 1550; await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual(['tick:5'])
    clock = 1600; await vi.advanceTimersByTimeAsync(50)
    expect(events).toEqual(['tick:5', 'tick:6']); expect(errors).toEqual([])
    await schedule.dispose(); clock = 2000; await vi.advanceTimersByTimeAsync(1000); expect(events).toHaveLength(2)
  })
  it('joins pending admission on shutdown and never launches the next timer', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    let finish!: () => void, settled = false
    const accepted = new Promise<void>(resolve => { finish = resolve })
    const schedule = startAutomationSchedule({ jobKey: 'periodic', agentKey: 'writer', trigger: { kind: 'interval', anchor: new Date(1000).toISOString(), intervalMs: 100, text: 'review' } },
      () => accepted, Date.now, () => undefined)
    await vi.advanceTimersByTimeAsync(100)
    const disposal = schedule.dispose().then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    finish(); await disposal; expect(vi.getTimerCount()).toBe(0)
  })
})

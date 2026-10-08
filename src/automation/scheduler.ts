import type { AutomationJob } from './config-types.js'

/** The first tick is strictly after startup; restarting never backfills prior work. */
export function nextAutomationTick(anchorMs: number, intervalMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - anchorMs) / intervalMs) + 1)
}
/** Own one timer and take only the newest due tick after a delayed wakeup. */
export function startAutomationSchedule(job: AutomationJob & { readonly trigger: Extract<AutomationJob['trigger'], { kind: 'interval' }> },
  accept: (eventId: string, text: string) => Promise<void>, now: () => number, failed: (error: unknown) => void): { dispose(): Promise<void> } {
  const anchor = Date.parse(job.trigger.anchor), interval = job.trigger.intervalMs
  let next = nextAutomationTick(anchor, interval, now()), active = true, timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> = Promise.resolve()
  const arm = (): void => {
    const delay = Math.min(2147483647, Math.max(1, anchor + next * interval - now()))
    timer = setTimeout(() => {
      timer = undefined
      if (!active) return
      const latest = Math.floor((now() - anchor) / interval)
      if (latest < next) { arm(); return }
      next = latest + 1
      pending = accept(`tick:${latest}`, job.trigger.text)
      void pending.then(() => { if (active) arm() }, error => { failed(error); if (active) arm() })
    }, delay)
  }
  arm()
  return { async dispose() { active = false; if (timer !== undefined) clearTimeout(timer); await pending.catch(() => undefined) } }
}

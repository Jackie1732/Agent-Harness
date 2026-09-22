import type { Clock } from '../foundation/clock.js'
import type { HostSchedulingConfig } from './config.js'
import type { HostRunReport, HostSlot } from './runtime-types.js'
import type { OutboxMessageSnapshot } from '../communication/types.js'
import { CommunicationError } from '../communication/errors.js'
import type { HostTimer } from './timer.js'
import { observeHostMembers } from './report.js'
import type { HostObservations } from './observation.js'
import type { HostAssembly } from './assembly.js'
import { HostSchedulerTasks } from './scheduler-tasks.js'
import { projectCommunicationFacts } from '../communication/projection.js'

type HostSchedulerLane = 'delivery' | 'maintenance' | 'business'

export interface HostSchedulerState {
  cursor: number
  readonly laneOrder: HostSchedulerLane[]
  readonly memberCursors: Record<HostSchedulerLane, number>
  readonly faults: Set<string>
  readonly stalled: Map<string, { position: number; count: number }>
  readonly cooldowns: Map<string, number>
  readonly observations: HostObservations
}
export interface HostSchedulerInput {
  readonly slots: readonly HostSlot[]
  readonly paused: ReadonlySet<string>
  readonly routingPaused: ReadonlySet<string>
  readonly offline: ReadonlySet<string>
  readonly scheduling: HostSchedulingConfig
  readonly clock: Clock
  readonly timer: HostTimer
  readonly signal: AbortSignal
  readonly wakeSignal: AbortSignal
  readonly isStopping: () => boolean
  readonly canAttempt: (message: OutboxMessageSnapshot) => boolean
  readonly blockRoute: (error: CommunicationError) => boolean
  readonly blockedRoutes: () => readonly string[]
  readonly state: HostSchedulerState
  readonly scanWake: () => AbortSignal
  readonly assembly: HostAssembly
}

/** Run shells are observations, not domain progress. */
function domainPosition(slot: HostSlot): number {
  const events = slot.session.snapshot().history.at(-1)?.events ?? []
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.stored.type !== 'agent/run-started' && event.stored.type !== 'agent/run-settled') return event.stored.sequence
  }
  return 0
}

function retryReady(input: HostSchedulerInput, slot: HostSlot, message: OutboxMessageSnapshot): boolean {
  const retry = input.scheduling.retryIntervalMs
  if (message.lastFailure === undefined && message.attemptCount === 0) return true
  const events = slot.session.snapshot().history.at(-1)?.events ?? []
  const last = message.lastFailure === undefined ? undefined : events.find(item => item.stored.eventId === message.lastFailure!.eventId)
  const observed = input.state.cooldowns.get(message.messageId)
  if (observed === undefined) {
    input.state.cooldowns.set(message.messageId, input.timer.now() + retry)
    return false
  }
  return input.timer.now() >= observed && (last === undefined || Date.parse(last.stored.recordedAt) + retry <= input.clock.now())
}

/** A finite admission budget with independent business, maintenance and delivery lanes. */
export async function runHostScheduler(input: HostSchedulerInput): Promise<HostRunReport> {
  const { slots, state, scheduling } = input
  const accepted = new HostSchedulerTasks(input.signal)
  let batches = 0
  let businessRuns = 0
  let maintenanceRuns = 0
  let deliveryAttempts = 0
  let scannedWithoutWork = 0
  let stoppedBy: HostRunReport['stoppedBy'] = 'quiescent'
  let business: Promise<void> | undefined
  let maintenance: Promise<void> | undefined
  let delivery: Promise<void> | undefined
  const busy = new Set<HostSlot>()
  const expirations = new Map<string, Promise<void>>()
  const attempted = new Set<string>()
  const failed = (slot: HostSlot): void => { state.faults.add(slot.member.agentKey) }
  const work = (slot: HostSlot, operation: () => Promise<unknown>): Promise<void> => {
    const before = domainPosition(slot)
    return Promise.resolve().then(operation).then(() => {
      const position = domainPosition(slot)
      const previous = state.stalled.get(slot.member.agentKey)
      state.stalled.set(slot.member.agentKey, { position, count: position === before ? (previous?.count ?? 0) + 1 : 0 })
    }, () => failed(slot)).finally(() => busy.delete(slot))
  }
  const pending = (slot: HostSlot) => input.routingPaused.has(slot.member.agentKey) ? [] : state.observations.read(slot, input.clock.now()).communication.outbox.filter(item =>
    item.status === 'pending' && !attempted.has(item.messageId) && input.canAttempt(item) && retryReady(input, slot, item))
  try {
    while (slots.length > 0) {
      const notified = input.scanWake()
      const stopping = accepted.signal.aborted || input.isStopping()
      const atBudget = batches >= scheduling.maxBatchesPerRun
      if (stopping) stoppedBy = input.signal.aborted ? 'aborted' : 'host-stopping'
      else if (atBudget) stoppedBy = 'batch-budget'
      const count = Math.min(scheduling.maxSlotsPerScan, slots.length)
      const selected = Array.from({ length: count }, (_, offset) => slots[(state.cursor + offset) % slots.length]!)
      state.cursor = (state.cursor + count) % slots.length
      let admitted = false
      for (const slot of selected) {
        if (input.offline.has(slot.member.agentKey)) continue
        // Expiry continues while an accepted run drains, even after its admission budget is exhausted.
        if (!input.signal.aborted && slot.agent.status === 'accepting') {
          for (const root of state.observations.read(slot, input.clock.now()).roots) {
            if (root.outcome !== null || root.stopControl !== null || Date.parse(root.deadline) > input.clock.now() || expirations.has(root.id)) continue
            const task = accepted.run(() => slot.agent.expire(root.id).then(() => undefined, () => failed(slot)).finally(() => expirations.delete(root.id)))
            expirations.set(root.id, task)
          }
        }
      }
      // Serving a lane moves only that lane to the back. Unseen pages retain priority.
      const lanes = [...state.laneOrder]
      for (const lane of lanes) {
        if (stopping || batches >= scheduling.maxBatchesPerRun) break
        if (lane === 'delivery' && delivery !== undefined || lane === 'maintenance' && maintenance !== undefined || lane === 'business' && business !== undefined) continue
        const start = state.memberCursors[lane]
        const candidates = Array.from({ length: count }, (_, offset) => slots[(start + offset) % slots.length]!)
        state.memberCursors[lane] = (start + count) % slots.length
        const eligible = candidates.filter(slot => !input.offline.has(slot.member.agentKey) && !state.faults.has(slot.member.agentKey))
        for (const slot of eligible) {
          if (lane === 'delivery') {
            const candidates = pending(slot)
            if (candidates.length > 0) {
              batches++; admitted = true
              const before = new Map(candidates.map(item => [item.messageId, item.attemptCount]))
              delivery = accepted.run(() => Promise.resolve().then(() => slot.dispatcher.dispatch({ signal: accepted.signal,
                onlyMessageIds: new Set(candidates.map(item => item.messageId)) })).catch(cause => {
                if (!(cause instanceof CommunicationError && input.blockRoute(cause))) failed(slot)
              }).then(() => {
                for (const item of projectCommunicationFacts(slot.session.snapshot()).outbox) {
                  const prior = before.get(item.messageId)
                  if (prior !== undefined && item.attemptCount > prior) {
                    deliveryAttempts += item.attemptCount - prior; attempted.add(item.messageId)
                    state.cooldowns.set(item.messageId, input.timer.now() + scheduling.retryIntervalMs)
                  }
                  if (item.status !== 'pending') state.cooldowns.delete(item.messageId)
                }
              }).finally(() => { delivery = undefined }))
            } else continue
          } else {
            if (busy.has(slot)) continue
            const stalled = state.stalled.get(slot.member.agentKey)
            if (stalled !== undefined && stalled.position === domainPosition(slot) && stalled.count >= scheduling.maxNoProgressBatches) continue
            const readiness = state.observations.read(slot, input.clock.now()).readiness
            if (lane === 'maintenance') {
              if (!readiness.canMaintain) continue
              batches++; maintenanceRuns++; admitted = true
              maintenance = accepted.run(() => work(slot, () => slot.agent.maintain({ signal: accepted.signal })).finally(() => { maintenance = undefined }))
            } else {
              if (input.paused.has(slot.member.agentKey) || !readiness.canRun) continue
              batches++; businessRuns++; admitted = true
              business = accepted.run(() => work(slot, () => slot.agent.start({ signal: accepted.signal })).finally(() => { business = undefined }))
            }
          }
          state.memberCursors[lane] = (slots.indexOf(slot) + 1) % slots.length
          state.laneOrder.splice(state.laneOrder.indexOf(lane), 1)
          state.laneOrder.push(lane)
          // Reserve the member before another lane can admit work in this scan.
          if (lane !== 'delivery') busy.add(slot)
          break
        }
      }
      const tasks = accepted.pending
      if (tasks.length === 0) {
        if (stopping || batches >= scheduling.maxBatchesPerRun) break
        scannedWithoutWork = admitted ? 0 : scannedWithoutWork + count
        if (scannedWithoutWork >= slots.length) break
        continue
      }
      scannedWithoutWork = 0
      // The local wait is always cancelled after a lane settles; no orphan timeout accumulates.
      const wake = new AbortController()
      const waitSignal = input.isStopping() ? wake.signal : AbortSignal.any([wake.signal, input.wakeSignal, notified])
      try { await Promise.race([...tasks, input.timer.wait(scheduling.scanIntervalMs, waitSignal)]) }
      finally { wake.abort() }
    }
    const observed = observeHostMembers(slots, input.paused, state.faults, input.clock, scheduling.maxReportEntries, state.observations, input.assembly, input.routingPaused)
    const remaining = new Set<string>(slots.flatMap(slot => state.observations.read(slot, input.clock.now()).communication.outbox.filter(item => item.status === 'pending').map(item => item.messageId)))
    for (const id of state.cooldowns.keys()) if (!remaining.has(id)) state.cooldowns.delete(id)
    if (stoppedBy === 'quiescent' && (observed.counts.pendingOutbox > 0 || state.faults.size > 0
      || [...state.stalled.values()].some(item => item.count >= scheduling.maxNoProgressBatches))) stoppedBy = 'no-progress'
    return Object.freeze({ batches, businessRuns, maintenanceRuns, deliveryAttempts, stoppedBy,
      blockedRoutes: Object.freeze(input.blockedRoutes()), ...observed })
  } catch (cause) { accepted.fail(cause); throw cause }
  finally { await accepted.join() }
}

import type { Clock } from '../foundation/clock.js'
import type { HostSchedulingConfig } from './config.js'
import type { HostRunReport, HostSlot } from './runtime-types.js'
import type { OutboxMessageSnapshot } from '../communication/types.js'
import { CommunicationError } from '../communication/errors.js'

export interface HostSchedulerInput {
  readonly slots: readonly HostSlot[]
  readonly paused: ReadonlySet<string>
  readonly scheduling: HostSchedulingConfig
  readonly clock: Clock
  readonly signal?: AbortSignal
  readonly isStopping: () => boolean
  readonly canAttempt: (message: OutboxMessageSnapshot) => boolean
  readonly blockRoute: (error: CommunicationError) => boolean
  readonly blockedRoutes: () => readonly string[]
  readonly cursor: number
}

export interface HostSchedulerResult {
  readonly report: HostRunReport
  readonly cursor: number
}

function members(slots: readonly HostSlot[], paused: ReadonlySet<string>, clock: Clock): HostRunReport['members'] {
  const observedAt = new Date(clock.now()).toISOString()
  return Object.freeze(slots.map(slot => Object.freeze({
    agentKey: slot.member.agentKey,
    sessionId: slot.member.sessionId,
    paused: paused.has(slot.member.agentKey),
    readiness: slot.agent.readiness(observedAt),
    agent: slot.agent.report(),
  })))
}

function retryReady(slot: HostSlot, message: OutboxMessageSnapshot, now: number, retryIntervalMs: number): boolean {
  if (message.lastFailure === undefined) return true
  const event = slot.session.snapshot().history.at(-1)?.events.find(item => item.stored.eventId === message.lastFailure!.eventId)
  if (event === undefined) return false
  return Date.parse(event.stored.recordedAt) + retryIntervalMs <= now
}

async function dispatchMessages(
  slot: HostSlot,
  candidates: readonly OutboxMessageSnapshot[],
  attempted: Set<string>,
  signal?: AbortSignal,
  blockRoute?: (error: CommunicationError) => boolean,
): Promise<number> {
  const selected = candidates
  if (selected.length === 0) return 0
  const ids = new Set(selected.map(item => item.messageId))
  const attemptsBefore = new Map(selected.map(item => [item.messageId, item.attemptCount]))
  let dispatch
  try {
    dispatch = await slot.dispatcher.dispatch({
      ...(signal === undefined ? {} : { signal }),
      onlyMessageIds: ids,
    })
  } catch (cause) {
    const started = markAttempted(slot, attemptsBefore, attempted)
    if (cause instanceof CommunicationError && cause.code === 'MESSAGE_TRANSPORT_SOURCE_INVALID'
      && blockRoute?.(cause) === true) return started
    throw cause
  }
  markAttempted(slot, attemptsBefore, attempted)
  return dispatch.startedAttempts
}

function markAttempted(slot: HostSlot, attemptsBefore: ReadonlyMap<string, number>, attempted: Set<string>): number {
  let started = 0
  for (const item of slot.mailbox.snapshot().outbox) {
    const before = attemptsBefore.get(item.messageId)
    if (before !== undefined && item.attemptCount > before) {
      attempted.add(item.messageId)
      started += item.attemptCount - before
    }
  }
  return started
}

/** Run bounded persistent-work scans; notifications only reduce later scan latency. */
export async function runHostScheduler(input: HostSchedulerInput): Promise<HostSchedulerResult> {
  const { slots, paused, scheduling, clock } = input
  if (slots.length === 0) return {
    cursor: 0,
    report: Object.freeze({ batches: 0, businessRuns: 0, maintenanceRuns: 0, deliveryAttempts: 0,
      stoppedBy: 'quiescent', blockedRoutes: Object.freeze(input.blockedRoutes()), members: Object.freeze([]) }),
  }
  let cursor = input.cursor % slots.length
  let batches = 0
  let businessRuns = 0
  let maintenanceRuns = 0
  let deliveryAttempts = 0
  let noProgress = 0
  let stoppedBy: HostRunReport['stoppedBy'] = 'batch-budget'
  const attempted = new Set<string>()
  const signalOptions = input.signal === undefined ? {} : { signal: input.signal }
  for (; batches < scheduling.maxBatchesPerRun; batches++) {
    if (input.signal?.aborted === true) { stoppedBy = 'aborted'; break }
    if (input.isStopping()) { stoppedBy = 'host-stopping'; break }
    const before = slots.map(slot => slot.session.snapshot().localPosition)
    const count = Math.min(scheduling.maxSlotsPerScan, slots.length)
    const selected = Array.from({ length: count }, (_, offset) => slots[(cursor + offset) % slots.length]!)
    cursor = (cursor + count) % slots.length
    let admittedBusiness = false
    for (const slot of selected) {
      if (input.isStopping()) break
      const pending = slot.mailbox.snapshot().outbox.filter(item => item.status === 'pending' && !attempted.has(item.messageId)
        && input.canAttempt(item) && retryReady(slot, item, clock.now(), scheduling.retryIntervalMs))
      deliveryAttempts += await dispatchMessages(slot, pending, attempted, input.signal, input.blockRoute)
      const readiness = slot.agent.readiness(new Date(clock.now()).toISOString())
      if (readiness.canMaintain) {
        await slot.agent.maintain(signalOptions)
        maintenanceRuns += 1
      }
      const refreshed = slot.agent.readiness(new Date(clock.now()).toISOString())
      if (!admittedBusiness && !paused.has(slot.member.agentKey) && refreshed.canRun) {
        await slot.agent.start(signalOptions)
        businessRuns += 1
        admittedBusiness = true
        const generated = slot.mailbox.snapshot().outbox.filter(item => item.status === 'pending' && !attempted.has(item.messageId)
          && input.canAttempt(item) && retryReady(slot, item, clock.now(), scheduling.retryIntervalMs))
        deliveryAttempts += await dispatchMessages(slot, generated, attempted, input.signal, input.blockRoute)
      }
    }
    const progressed = slots.some((slot, index) => slot.session.snapshot().localPosition !== before[index])
    noProgress = progressed ? 0 : noProgress + 1
    const observedAt = new Date(clock.now()).toISOString()
    const actionable = slots.some(slot => {
      const readiness = slot.agent.readiness(observedAt)
      return readiness.canMaintain || !paused.has(slot.member.agentKey) && readiness.canRun
        || slot.mailbox.snapshot().outbox.some(item => item.status === 'pending' && !attempted.has(item.messageId)
          && input.canAttempt(item) && retryReady(slot, item, clock.now(), scheduling.retryIntervalMs))
    })
    if (!actionable) {
      stoppedBy = slots.some(slot => slot.mailbox.snapshot().outbox.some(item => item.status === 'pending')) ? 'no-progress' : 'quiescent'
      batches += 1
      break
    }
    if (noProgress >= scheduling.maxNoProgressBatches) {
      stoppedBy = 'no-progress'
      batches += 1
      break
    }
  }
  return {
    cursor,
    report: Object.freeze({ batches, businessRuns, maintenanceRuns, deliveryAttempts, stoppedBy,
      blockedRoutes: Object.freeze(input.blockedRoutes()),
      members: members(slots, paused, clock) }),
  }
}

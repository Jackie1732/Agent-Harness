import { assertNever } from '../foundation/never.js'
import { CommunicationError } from './errors.js'
import { SessionMailboxImpl } from './mailbox.js'
import type { MessageTransport } from './transport.js'
import type { MessageDeliveryOutcome, OutboxDispatchReport, OutboxMessageSnapshot } from './types.js'

/** Explicit, bounded driver for one Session Outbox. */
export interface OutboxDispatcher {
  /** Run eligible Channel heads once within the configured run budget. */
  dispatch(options?: { readonly signal?: AbortSignal }): Promise<OutboxDispatchReport>
}

function channelKey(message: OutboxMessageSnapshot): string {
  return `${message.envelope.recipient}\u0000${message.envelope.channelId}`
}

function nextChannelHead(
  messages: readonly OutboxMessageSnapshot[],
  blockedChannels: ReadonlySet<string>,
): OutboxMessageSnapshot | undefined {
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.status !== 'pending') continue
    const key = channelKey(message)
    if (seen.has(key)) continue
    seen.add(key)
    if (!blockedChannels.has(key)) return message
  }
  return undefined
}

/** Create the single-run coordinator for one Service-owned Mailbox. */
export function createOutboxDispatcher(
  mailbox: SessionMailboxImpl,
  transport: MessageTransport,
): OutboxDispatcher {
  let runTask: Promise<OutboxDispatchReport> | undefined

  const run = async (signal?: AbortSignal): Promise<OutboxDispatchReport> => {
    let startedAttempts = 0
    let delivered = 0
    let rejected = 0
    let retryable = 0
    let abandoned = 0
    let stoppedBy: OutboxDispatchReport['stoppedBy'] = 'idle'
    const blockedChannels = new Set<string>()
    while (true) {
      if (signal?.aborted === true) {
        stoppedBy = 'aborted'
        break
      }
      if (mailbox.status !== 'open') {
        stoppedBy = 'mailbox-inactive'
        break
      }
      const candidate = nextChannelHead(mailbox.currentSnapshot().outbox, blockedChannels)
      if (candidate === undefined) break
      if (startedAttempts >= mailbox.limits.maxAttemptsPerRun) {
        stoppedBy = 'run-budget'
        break
      }
      const prepared = await mailbox.prepareAttempt(candidate.messageId, signal)
      if (prepared.kind === 'ineligible') {
        blockedChannels.add(channelKey(candidate))
        continue
      }
      if (prepared.kind === 'exhausted') {
        abandoned += 1
        continue
      }
      startedAttempts += 1
      let outcome: MessageDeliveryOutcome
      let deliveryFailure: CommunicationError | undefined
      try {
        outcome = await transport.deliver(prepared.lease.envelope, { signal: prepared.lease.signal })
      } catch (cause) {
        if (cause instanceof CommunicationError) deliveryFailure = cause
        outcome = Object.freeze({ kind: 'retry', code: 'transport-outcome-unknown' })
      }
      const result = await mailbox.completeAttempt(prepared.lease, outcome)
      switch (result) {
        case 'delivered': delivered += 1; break
        case 'rejected': rejected += 1; break
        case 'retryable': retryable += 1; blockedChannels.add(channelKey(candidate)); break
        case 'abandoned': abandoned += 1; break
        default: assertNever(result, 'delivery completion')
      }
      if (deliveryFailure !== undefined) throw deliveryFailure
    }
    const remainingPending = mailbox.currentSnapshot().outbox.filter(item => item.status === 'pending').length
    return Object.freeze({
      startedAttempts,
      delivered,
      rejected,
      retryable,
      abandoned,
      remainingPending,
      stoppedBy,
    })
  }

  const dispatcher: OutboxDispatcher = Object.freeze({
    dispatch(options: { readonly signal?: AbortSignal } = {}) {
      if (runTask !== undefined) return runTask
      const task = run(options.signal).finally(() => {
        if (runTask === task) runTask = undefined
      })
      runTask = task
      return task
    },
  })
  return dispatcher
}

import { CommunicationError } from './errors.js'
import type { CommunicationPolicy, MailboxLimits, MessagePolicyDecision } from './types.js'

const REASON_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

function safeInteger(value: number, label: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new CommunicationError('MESSAGE_CONFIG_INVALID', `${label} is outside its supported range`, {
      details: { label, value },
    })
  }
}

/** Validate and freeze one complete communication resource budget. */
export function validateMailboxLimits(limits: MailboxLimits): MailboxLimits {
  safeInteger(limits.maxMessageBytes, 'maxMessageBytes', false)
  safeInteger(limits.maxPendingOutbox, 'maxPendingOutbox', true)
  safeInteger(limits.maxPendingInbox, 'maxPendingInbox', true)
  safeInteger(limits.maxDeliveryAttempts, 'maxDeliveryAttempts', false)
  safeInteger(limits.maxAttemptsPerRun, 'maxAttemptsPerRun', false)
  safeInteger(limits.maxSendJournalConflicts, 'maxSendJournalConflicts', true)
  return Object.freeze({ ...limits })
}

/** Validate the policy surface and freeze its identity for one attachment. */
export function validateCommunicationPolicy(policy: CommunicationPolicy): CommunicationPolicy {
  if (typeof policy.canSend !== 'function' || typeof policy.canReceive !== 'function') {
    throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'communication policy requires send and receive decisions')
  }
  const canSend = policy.canSend.bind(policy)
  const canReceive = policy.canReceive.bind(policy)
  return Object.freeze({ canSend, canReceive })
}

/** Reject malformed policy results before they can affect durable state. */
export function validatePolicyDecision(decision: MessagePolicyDecision): MessagePolicyDecision {
  if (decision.kind === 'allow') return decision
  if (decision.kind === 'deny' && REASON_CODE_PATTERN.test(decision.reasonCode)) return decision
  throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'communication policy returned an invalid decision')
}

/** Evaluate one policy callback without exposing arbitrary thrown values or unstable errors. */
export function evaluatePolicyDecision(decide: () => MessagePolicyDecision): MessagePolicyDecision {
  try {
    return validatePolicyDecision(decide())
  } catch (cause) {
    if (cause instanceof CommunicationError) throw cause
    throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'communication policy evaluation failed')
  }
}

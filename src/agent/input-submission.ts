import { agentJson, exact, record, text } from './validation.js'
import { invalidAgent } from './errors.js'
import type { AgentInputAccepted } from './event-contract.js'
import { decodeInputAccepted } from './event-codec.js'

/** Persistent caller identity; each Session owns its local namespace/key tuples. */
export type AgentInputSubmission = { readonly namespace: string; readonly key: string }
export type AgentKeyedInputAccepted = AgentInputAccepted & { readonly submission: AgentInputSubmission }

/** Decode durable or external submission identity without concatenating its tuple. */
export function decodeInputSubmission(value: unknown): AgentInputSubmission {
  const input = record(agentJson(value)); exact(input, ['namespace', 'key'])
  const namespace = text(input.namespace, 64); const key = text(input.key, 64)
  if (![namespace, key].every(part => /^[A-Za-z0-9._:-]+$/.test(part))) invalidAgent('invalid-submission-identity')
  return Object.freeze({ namespace, key })
}

/** Version 2 retains the original input and its stable caller identity. */
export function decodeKeyedInputAccepted(value: unknown): AgentKeyedInputAccepted {
  const input = record(agentJson(value)); exact(input, ['spec', 'input', 'submission'])
  const accepted = decodeInputAccepted({ spec: input.spec!, input: input.input! })
  return Object.freeze({ ...accepted, submission: decodeInputSubmission(input.submission) })
}

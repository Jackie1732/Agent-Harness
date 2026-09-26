import type { AgentBudget } from './contract.js'
import type { AgentActionIntent } from './event-contract.js'
import { invalidAgent } from './errors.js'
import { exact, integer, record } from './validation.js'

export const budgetFields = ['models', 'steps', 'tools', 'messages', 'waits', 'outputTokens'] as const
export const emptyAgentBudget: AgentBudget = Object.freeze({ models: 0, steps: 0, tools: 0, messages: 0, waits: 0, outputTokens: 0 })

export function decodeAgentBudget(value: unknown): AgentBudget {
  const input = record(value)
  exact(input, budgetFields)
  for (const field of budgetFields) integer(input[field])
  return input as AgentBudget
}

/** Safe monotonic reservation; no result, denial or recovery refunds a reservation. */
export function reserveAgentBudget(used: AgentBudget, amount: AgentBudget, maximum: AgentBudget): AgentBudget | null {
  const next = { ...used }
  for (const field of budgetFields) {
    if (amount[field] > maximum[field] - used[field]) return null
    next[field] += amount[field]
    if (!Number.isSafeInteger(next[field])) invalidAgent('budget-overflow')
  }
  return Object.freeze(next)
}

export function actionBudget(routes: readonly AgentActionIntent['route'][]): AgentBudget {
  return Object.freeze({ ...emptyAgentBudget,
    tools: routes.filter(route => route === 'tool').length,
    messages: routes.filter(route => route === 'send' || route === 'reply' || route === 'work-progress').length,
    waits: routes.filter(route => ['wait', 'ask', 'spawn', 'await-subagent', 'answer-subagent', 'ask-parent'].includes(route)).length,
  })
}

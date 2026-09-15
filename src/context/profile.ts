import type { ContextProfile, ContextBudgetLimits, ContextTokenAccounting, PromptSection } from './contract.js'
import { invalidContext } from './errors.js'
import { array, choice, compareText, contextJson, exact, identifier, integer, previous, record, text, unique, contextJsonCeiling } from './validation.js'

const slots = ['rules', 'task', 'output'] as const
const budgetFields = ['contextWindowTokens', 'outputReserveTokens', 'safetyMarginTokens', 'maxRequestBytes', 'maxAssemblyBytes',
  'maxSourceEvents', 'maxSourceBytes', 'maxUnits', 'maxProvenanceEntries', 'maxMemoryCandidates', 'maxMemoryEstimatedTokens',
  'maxJsonDepth', 'maxJsonNodes', 'minSavingsBytes'] as const
const zeroFields = new Set<string>(['safetyMarginTokens', 'maxMemoryCandidates', 'maxMemoryEstimatedTokens', 'minSavingsBytes'])

function budget(value: unknown): ContextBudgetLimits {
  const input = record(value); exact(input, budgetFields)
  for (const key of budgetFields) integer(input[key], zeroFields.has(key) ? 0 : 1)
  if (integer(input.outputReserveTokens) + integer(input.safetyMarginTokens) > integer(input.contextWindowTokens)) invalidContext('token-reserve')
  for (const key of ['maxRequestBytes', 'maxAssemblyBytes']) integer(input[key], 1, contextJsonCeiling.maxBytes)
  integer(input.maxSourceBytes, 1, 128 * 1024 * 1024)
  for (const key of ['maxSourceEvents', 'maxUnits', 'maxMemoryCandidates']) integer(input[key], key === 'maxMemoryCandidates' ? 0 : 1, 10000)
  integer(input.maxProvenanceEntries, 1, 100000)
  integer(input.maxJsonDepth, 1, contextJsonCeiling.maxDepth)
  integer(input.maxJsonNodes, 1, contextJsonCeiling.maxNodes)
  return input as ContextBudgetLimits
}
function accounting(value: unknown): ContextTokenAccounting {
  const input = record(value); exact(input, ['mode', 'algorithm', 'bytesPerEstimatedToken', 'fixedOverheadEstimate'])
  choice(input.mode, ['estimate-accepted', 'exact-required'])
  choice(input.algorithm, ['neutral-json-utf8-estimate/v1'])
  integer(input.bytesPerEstimatedToken, 1, 1024)
  integer(input.fixedOverheadEstimate)
  return input as ContextTokenAccounting
}

/** No templates or ambient defaults. The persisted revision contains the final literals. */
export function decodeContextProfile(value: unknown): ContextProfile {
  const input = record(contextJson(value))
  exact(input, ['profileKey', 'purpose', 'previousEventId', 'sections', 'toolNames', 'rendererVersion', 'historyScope', 'tokenAccounting', 'budget'])
  identifier(input.profileKey); previous(input.previousEventId)
  const purpose = choice(input.purpose, ['generation', 'compaction'])
  choice(input.rendererVersion, ['context-neutral/v1'])
  choice(input.historyScope, ['local-only', 'allow-lineage'])
  budget(input.budget); accounting(input.tokenAccounting)
  const sections = array(input.sections, 64).map(item => {
    const section = record(item); exact(section, ['name', 'slot', 'ordinal', 'text', 'originLabel'])
    identifier(section.name); choice(section.slot, slots); integer(section.ordinal); text(section.text, 65536); text(section.originLabel, 128)
    return section as PromptSection
  })
  unique(sections.map(section => section.name)); unique(sections.map(section => String(section.ordinal)))
  sections.sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot) || a.ordinal - b.ordinal || compareText(a.name, b.name))
  const tools = array(input.toolNames, 64).map(item => {
    const name = text(item, 64)
    if (!/^[A-Za-z0-9_-]+$/.test(name)) invalidContext('tool-name')
    return name
  })
  unique(tools)
  if (purpose === 'compaction' && (tools.length > 0 || !sections.some(section => section.slot === 'task'))) invalidContext('compaction-profile')
  return Object.freeze({ ...input, sections: Object.freeze(sections) }) as ContextProfile
}

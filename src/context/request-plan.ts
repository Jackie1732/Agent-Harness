import type { JsonValue } from '../foundation/json.js'
import type { ModelInputMessage, ModelRequest } from '../model/contract.js'
import type { ContextCapturedFacts, ContextProfile, ContextProvenance, ContextSelectedUnit, ContextSelectionSpec } from './contract.js'
import { renderUnit } from './render.js'
import type { ContextUnit } from './unit.js'
import { unitDigest } from './unit.js'
import { digest } from './validation.js'

export interface SelectedGroup {
  readonly unit: ContextUnit
  readonly placement: ContextSelectedUnit['placement']
  readonly representation: ContextSelectedUnit['representation']
}
/** Instructions are exclusively literal Profile sections. Every other source stays in message data. */
export function renderContextRequest(profile: ContextProfile, selection: ContextSelectionSpec, captured: ContextCapturedFacts, groups: readonly SelectedGroup[]): ModelRequest {
  const target = selection.target
  const messages: ModelInputMessage[] = []
  for (const group of groups) messages.push(...renderUnit(group.unit, group.representation))
  return { model: target.model, instructions: profile.sections.map(section => section.text), messages,
    tools: captured.tools.map(tool => tool.model), maxOutputTokens: target.maxOutputTokens,
    ...(target.temperature === undefined ? {} : { temperature: target.temperature }),
    ...(target.topP === undefined ? {} : { topP: target.topP }), ...(target.profile === undefined ? {} : { profile: target.profile }) }
}
export function contextProvenance(profile: ContextProfile, selection: ContextSelectionSpec, captured: ContextCapturedFacts, groups: readonly SelectedGroup[]): readonly ContextProvenance[] {
  const entries: ContextProvenance[] = profile.sections.map((section, index) => ({ location: `instructions[${index}]`,
    source: { kind: 'profile-section', eventId: selection.profileEventId, name: section.name }, sourceDigest: digest(section) }))
  captured.tools.forEach((tool, index) => entries.push({ location: `tools[${index}]`, source: { kind: 'tool-surface', name: tool.definition.name }, sourceDigest: digest(tool) }))
  for (const field of ['model', 'maxOutputTokens', 'temperature', 'topP', 'profile'] as const) {
    const value = selection.target[field]
    if (value !== undefined) entries.push({ location: field, source: { kind: 'inline-control', field }, sourceDigest: digest(value as JsonValue) })
  }
  let messageIndex = 0
  for (const group of groups) {
    const source = { kind: 'unit' as const, reference: group.unit.reference, eventIds: group.unit.sourceEventIds, representation: group.representation }
    const sourceDigest = unitDigest(group.unit)
    for (const message of renderUnit(group.unit, group.representation)) {
      for (let index = 0; index < message.content.length; index++) entries.push({ location: `messages[${messageIndex}].content[${index}]`, source, sourceDigest })
      if (message.role === 'assistant' && message.continuation !== undefined) entries.push({ location: `messages[${messageIndex}].continuation`, source, sourceDigest })
      messageIndex++
    }
  }
  return Object.freeze(entries)
}
/** Neutral compatibility only. Actual providers still own stricter offline prepare checks. */
export function incompatibleContinuation(selection: ContextSelectionSpec, groups: readonly SelectedGroup[]): readonly ContextUnit[] {
  return groups.filter(group => renderUnit(group.unit, group.representation).some(message => {
    if (message.role !== 'assistant' || message.continuation === undefined) return false
    const capsule = message.continuation; const target = selection.target
    return capsule.providerId !== target.provider.providerId || capsule.model !== target.model
      || !target.provider.support.continuations.includes(`${capsule.namespace}@${capsule.version}`)
  })).map(group => group.unit)
}

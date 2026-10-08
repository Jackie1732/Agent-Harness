import type { JsonObject, JsonValue } from '../foundation/json.js'
import { relative } from 'node:path'
import { decodeHostConfig, planHostConfig, resolveHostConfig } from '../host/config.js'
import type { HostConfig, HostIdentitySource, ResolvedHostSpec } from '../host/config.js'
import { workflowMemberFingerprints } from '../host/workflow-authority.js'
import { compileHostMessageCatalog } from '../host/message-catalog.js'
import { formatSessionAddress, parseSessionId } from '../session/ids.js'
import { HostError } from '../host/errors.js'

/** Reject formatted but stale roster hashes using the actual resolved member. */
export function checkWorkflowRoster(spec: ResolvedHostSpec): void {
  if (spec.schemaVersion !== 3 || spec.workflows.kind === 'disabled') return
  for (const entry of spec.workflows.definitions) for (const peer of entry.definition.roster) {
    const member = spec.members.find(member => member.kind === 'local' && member.agentKey === peer.memberKey)
    if (member?.kind !== 'local') throw new HostError('HOST_CONFIG_INVALID', 'workflow-roster-member')
    const hashes = workflowMemberFingerprints(member)
    if (peer.address !== formatSessionAddress(parseSessionId(member.sessionId)) || peer.specFingerprint !== hashes.specFingerprint
      || peer.contextFingerprint !== hashes.contextFingerprint) throw new HostError('HOST_CONFIG_INVALID', 'stale-workflow-roster', { memberKey: peer.memberKey })
  }
}
/** Allocate local identities before computing references and fingerprints; publish only the complete result. */
export function rebuildWorkflowBindings(value: JsonValue, baseDirectory: string, identities?: HostIdentitySource): HostConfig {
  const input = value as JsonObject
  if (input.schemaVersion !== 3) throw new HostError('HOST_CONFIG_INVALID', 'workflow-bindings-requires-host-v3')
  const workflows = input.workflows as JsonObject
  const scaffold = planHostConfig(decodeHostConfig({ ...input, workflows: { kind: 'disabled' } }, baseDirectory), identities)
  const resolved = resolveHostConfig(scaffold)
  if (workflows.kind === 'disabled') { compileHostMessageCatalog(scaffold.messages); return scaffold }
  if (workflows.kind !== 'enabled' || !Array.isArray(workflows.definitions)) throw new HostError('HOST_CONFIG_INVALID', 'workflows-kind')
  const definitions = workflows.definitions.map(raw => {
    const entry = raw as JsonObject, definition = entry.definition as JsonObject
    if (!Array.isArray(definition.roster)) throw new HostError('HOST_CONFIG_INVALID', 'workflow-roster')
    const roster = definition.roster.map(raw => {
      const peer = raw as JsonObject, member = resolved.members.find(item => item.kind === 'local' && item.agentKey === peer.memberKey)
      if (member?.kind !== 'local') throw new HostError('HOST_CONFIG_INVALID', 'workflow-roster-member')
      return { ...peer, address: formatSessionAddress(parseSessionId(member.sessionId)), ...workflowMemberFingerprints(member) }
    })
    return { ...entry, definition: { ...definition, coordinator: entry.sessionId === null ? null : formatSessionAddress(parseSessionId(entry.sessionId as string)), roster } }
  })
  const planned = planHostConfig(decodeHostConfig({ ...scaffold, workflows: { ...workflows, definitions } }, baseDirectory), identities)
  const complete = resolveHostConfig(planned)
  compileHostMessageCatalog(planned.messages)
  checkWorkflowRoster(complete)
  return planned
}
/** Clone only local topologies and preserve each configuration generation. */
export function cloneHostCandidate(config: HostConfig, newStorage: string, hostKey: string, baseDirectory: string, identities?: HostIdentitySource): HostConfig {
  if (hostKey === config.hostKey) throw new HostError('HOST_CONFIG_INVALID', 'clone-host-key-must-change')
  if (relative(newStorage, config.storage.root) === '') throw new HostError('HOST_CONFIG_INVALID', 'clone-storage-must-change')
  if (config.members.some(member => member.kind !== 'local') || config.routes.some(route => route.origin !== null)
    || config.https.kind !== 'disabled') throw new HostError('HOST_CONFIG_INVALID', 'clone-remote-topology-unsupported')
  const dependent: string[] = []
  const inspect = (profile: { readonly previousEventId: unknown }, spec: { readonly context: { readonly memory: { readonly required: readonly unknown[] }; readonly compactions: readonly unknown[] } }, prefix: string) => {
    if (profile.previousEventId !== null) dependent.push(`${prefix}/profile/previousEventId`)
    if (spec.context.memory.required.length !== 0) dependent.push(`${prefix}/spec/context/memory/required`)
    if (spec.context.compactions.length !== 0) dependent.push(`${prefix}/spec/context/compactions`)
  }
  config.members.forEach((member, index) => { if (member.kind === 'local') inspect(member.profile, member.spec, `/members/${index}`) })
  if (config.schemaVersion !== 1 && config.subagents.kind === 'enabled') config.subagents.templates.forEach((template, index) => inspect(template.profile, template.spec, `/subagents/templates/${index}`))
  if (dependent.length !== 0) throw new HostError('HOST_CONFIG_INVALID', 'clone-log-references-unsupported', { fields: dependent.join(',') })
  const candidate = { ...config, hostKey, storage: { ...config.storage, root: newStorage },
    members: config.members.map(member => ({ ...member, mode: 'create', sessionId: null })),
    channels: config.channels.map(channel => ({ ...channel, channelId: null })), routes: config.routes.map(route => ({ ...route, ownerHost: hostKey })),
    ...(config.schemaVersion === 3 && config.workflows.kind === 'enabled' ? { workflows: { ...config.workflows,
      definitions: config.workflows.definitions.map(entry => ({ ...entry, sessionId: null })) } } : {}) }
  if (config.schemaVersion === 3) return rebuildWorkflowBindings(candidate as unknown as JsonValue, baseDirectory, identities)
  const planned = planHostConfig(decodeHostConfig(candidate, baseDirectory), identities)
  const resolved = resolveHostConfig(planned)
  compileHostMessageCatalog(resolved.messages)
  return planned
}

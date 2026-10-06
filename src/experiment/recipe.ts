import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { formatSessionAddress, parseSessionId } from '../session/ids.js'
import type { SessionId } from '../session/ids.js'
import { decodeHostConfig, planHostConfig, resolveHostConfig } from '../host/config.js'
import type { HostConfig, HostLocalMemberConfig } from '../host/config.js'
import { workflowMemberFingerprints } from '../host/workflow-authority.js'
import { exportHostConfig } from '../host/config-export.js'
import type { ExperimentDefinition, ExperimentLimits, ExperimentUnit, ExperimentVariant, FrozenExperimentCase } from './definition-types.js'
import { canonicalExperimentPath, experimentPathsOverlap } from './materials.js'
import { experimentJsonDigest, experimentRelativePath, experimentUnique, invalidExperiment } from './parsing.js'
import { ExperimentError } from './errors.js'
import { renderExperimentTask } from './input.js'

/** Preallocate a new Host recipe; only declared identity/path/task fields are relocated. */
export async function planExperimentUnit(item: FrozenExperimentCase, variant: ExperimentVariant, repetition: number, ordinal: number,
  journalId: SessionId, storage: ExperimentDefinition['storage'], limits: ExperimentLimits): Promise<ExperimentUnit> {
  const tuple = { caseKey: item.caseKey, variantKey: variant.variantKey, repetition }
  const unitKey = `unit-${experimentJsonDigest(tuple).slice(0, 32)}`
  const hostRoot = join(storage.controlRoot, 'runs', unitKey, 'host-store')
  const workspaceRoot = join(storage.workspaceRoot, journalId, unitKey)
  const entry = variant.bindings.find(binding => binding.caseKey === item.caseKey)!
  const task = renderExperimentTask(item, entry)
  if (entry.kind === 'agent') {
    const member = variant.recipe.members.find(member => member.kind === 'local' && member.agentKey === entry.agentKey)!
    if (member.kind !== 'local' || Buffer.byteLength(task) > member.spec.limits.maxInputBytes) invalidExperiment('rendered-agent-input-limit')
  }
  const members = variant.recipe.members.map(member => {
    if (member.kind !== 'local') invalidExperiment('experiment-local-members-required')
    if (member.tools.kind !== 'none' && (experimentRelativePath(member.agentKey, 'tool-agentKey').includes('/'))) invalidExperiment('tool-agentKey-directory')
    const tools = member.tools.kind === 'none' ? member.tools : { ...member.tools,
      rootPath: join(workspaceRoot, 'agents', member.agentKey), protectedRoots: [...new Set([...member.tools.protectedRoots, storage.controlRoot])] }
    return { ...member, mode: 'create' as const, sessionId: parseSessionId(randomUUID()), tools } satisfies HostLocalMemberConfig
  })
  const resourceSource = variant.recipe.schemaVersion === 3 ? variant.recipe.workspaceResources
    : variant.recipe.schemaVersion === 2 && variant.recipe.subagents.kind === 'enabled' ? variant.recipe.subagents.workspaceResources : []
  for (const resource of resourceSource) if (experimentRelativePath(resource.resourceId, 'resourceId').includes('/')) invalidExperiment('resourceId-directory')
  experimentUnique(members.filter(member => member.tools.kind !== 'none').map(member => member.agentKey.toLowerCase()), 'tool-directory')
  experimentUnique(resourceSource.map(resource => resource.resourceId.toLowerCase()), 'resource-directory')
  const resources = resourceSource.map(resource => ({ ...resource, rootPath: join(workspaceRoot, 'resources', resource.resourceId),
    protectedRoots: [...new Set([...resource.protectedRoots, storage.controlRoot])] }))
  const workflows = variant.recipe.schemaVersion === 3 && variant.recipe.workflows.kind === 'enabled' ? {
    ...variant.recipe.workflows, definitions: variant.recipe.workflows.definitions.map(record => {
      const sessionId = parseSessionId(randomUUID())
      const roster = (record.definition.roster as readonly JsonObject[]).map(peer => {
        const member = members.find(member => member.agentKey === peer.memberKey)
        if (member === undefined) invalidExperiment('workflow-roster-reference')
        return { ...peer, address: formatSessionAddress(member.sessionId) }
      })
      const nodes = (record.definition.nodes as readonly JsonObject[]).map(node => {
        const slot = entry.kind === 'workflow' && entry.workflowKey === record.definition.workflowKey ? entry.nodeTasks.find(slot => slot.nodeKey === node.nodeKey) : undefined
        if (slot === undefined) return node
        const rendered = `${slot.prefix}${task}`
        const executor = members.find(member => member.agentKey === node.executor)!
        if (Buffer.byteLength(rendered) > executor.spec.limits.maxInputBytes) invalidExperiment('rendered-workflow-input-limit')
        return { ...node, task: rendered }
      })
      return { sessionId, definition: { ...record.definition, coordinator: formatSessionAddress(sessionId), roster, nodes } }
    }),
  } : variant.recipe.schemaVersion === 3 ? variant.recipe.workflows : undefined
  const subagents = variant.recipe.schemaVersion === 2 && variant.recipe.subagents.kind === 'enabled'
    ? { ...variant.recipe.subagents, workspaceResources: resources } : variant.recipe.schemaVersion === 1 ? undefined : variant.recipe.subagents
  const raw = { ...variant.recipe, storage: { ...variant.recipe.storage, root: hostRoot }, members,
    channels: variant.recipe.channels.map(channel => ({ ...channel, channelId: null })),
    ...(workflows === undefined ? {} : { workflows }), ...(subagents === undefined ? {} : { subagents }),
    ...(variant.recipe.schemaVersion === 3 ? { workspaceResources: resources } : {}) }
  let config: HostConfig = planHostConfig(decodeHostConfig(raw, hostRoot))
  let recipe = resolveHostConfig(config)
  if (config.schemaVersion === 3 && config.workflows.kind === 'enabled') {
    const resolvedMembers = recipe.members
    config = decodeHostConfig({ ...config, workflows: { ...config.workflows, definitions: config.workflows.definitions.map(record => ({
      ...record, definition: { ...record.definition, roster: (record.definition.roster as readonly JsonObject[]).map(peer => {
        const member = resolvedMembers.find(member => member.kind === 'local' && member.agentKey === peer.memberKey)
        if (member?.kind !== 'local') invalidExperiment('workflow-roster-reference')
        return { ...peer, ...workflowMemberFingerprints(member) }
      }) },
    })) } }, hostRoot)
    recipe = resolveHostConfig(config)
  }
  const actualRoots = [...members.flatMap(member => member.tools.kind === 'none' ? [] : [{ root: member.tools.rootPath, protected: member.tools.protectedRoots }]),
    ...resources.map(resource => ({ root: resource.rootPath, protected: resource.protectedRoots }))]
  for (const access of actualRoots) {
    if (access.protected.length > 64) invalidExperiment('protected-roots-limit')
    for (const protectedRoot of access.protected) if (experimentPathsOverlap(await canonicalExperimentPath(access.root), await canonicalExperimentPath(protectedRoot))) invalidExperiment('authorized-protected-root-overlap')
  }
  if (recipe.members.length + (recipe.schemaVersion === 3 && recipe.workflows.kind === 'enabled' ? recipe.workflows.definitions.length : 0) > limits.maxSessionCount) invalidExperiment('recipe-session-count-limit')
  if (canonicalJsonBytes(recipe as unknown as JsonValue).byteLength > limits.maxRecipeBytes) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'recipe-bytes-limit')
  return snapshotJson({ ...tuple, unitKey, ordinal, hostRoot, workspaceRoot, config, recipe,
    recipeDigest: experimentJsonDigest(recipe as unknown as JsonValue), comparisonFingerprint: exportHostConfig(recipe).fingerprint, entry }) as unknown as ExperimentUnit
}

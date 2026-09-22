import { isAbsolute, resolve } from 'node:path'
import { agentJson, array, choice, exact, integer, record, text, unique } from '../agent/validation.js'
import type { AgentSubagentRole, SubagentLimits } from '../subagent/contract.js'
import { decodeAgentSubagentRole } from '../subagent/role-codec.js'
import type { ChildTemplate } from '../subagent/template.js'
import { decodeChildTemplate } from '../subagent/template.js'
import { decodeSubagentLimits } from '../subagent/request.js'
import { workspaceRelativePath } from '../tool/workspace-path.js'
import { HostError } from './errors.js'

export type HostParentSubagentConfig = Omit<Extract<AgentSubagentRole, { role: 'parent' }>, 'role'> & { readonly agentKey: string }
export type HostWorkspaceResource = {
  readonly resourceId: string
  readonly rootPath: string
  readonly mode: 'shared-read' | 'exclusive-write'
  readonly protectedRoots: readonly string[]
  readonly readPrefixes: readonly string[]
  readonly writePrefixes: readonly string[]
  readonly maxBaselineFiles: number
  readonly maxBaselineBytes: number
}
export type HostSubagentConfig = { readonly kind: 'disabled' } | {
  readonly kind: 'enabled'
  readonly templates: readonly ChildTemplate[]
  readonly parents: readonly HostParentSubagentConfig[]
  readonly workspaceResources: readonly HostWorkspaceResource[]
  readonly limits: SubagentLimits
}

/** Parse current Host authority; persisted parent rights remain an independent, stricter intersection. */
export function decodeHostSubagents(value: unknown): HostSubagentConfig {
  const input = record(agentJson(value))
  if (input.kind === 'disabled') { exact(input, ['kind']); return { kind: 'disabled' } }
  choice(input.kind, ['enabled']); exact(input, ['kind', 'templates', 'parents', 'workspaceResources', 'limits'])
  const templates = array(input.templates, 64).map(decodeChildTemplate)
  unique(templates.map(item => JSON.stringify([item.templateKey, item.templateVersion])))
  const parents = array(input.parents, 256).map(value => {
    const parent = record(value); exact(parent, ['agentKey', 'templates', 'capabilities', 'maxDelegations', 'maxGrant'])
    const { agentKey, ...fields } = parent
    const role = decodeAgentSubagentRole({ ...fields, role: 'parent' })
    if (role.role !== 'parent') throw new HostError('HOST_CONFIG_INVALID', 'parent-role')
    const { role: _role, ...authority } = role
    if (authority.templates.some(item => !templates.some(template => template.templateKey === item.templateKey && template.templateVersion === item.templateVersion))) throw new HostError('HOST_CONFIG_INVALID', 'parent-template-reference')
    return { ...authority, agentKey: text(agentKey, 128) }
  })
  unique(parents.map(item => item.agentKey))
  const workspaceResources = array(input.workspaceResources, 64).map(value => {
    const resource = record(value); exact(resource, ['resourceId', 'rootPath', 'mode', 'protectedRoots', 'readPrefixes', 'writePrefixes', 'maxBaselineFiles', 'maxBaselineBytes'])
    const absolute = (value: unknown) => {
      const path = text(value, 4096)
      if (!isAbsolute(path)) throw new HostError('HOST_CONFIG_INVALID', 'workspace-root-must-be-absolute')
      return resolve(path)
    }
    const paths = (value: unknown) => {
      const result = array(value, 10000).map(item => workspaceRelativePath(item, 4096)); unique(result.map(item => item.toLowerCase())); return result
    }
    const mode = choice(resource.mode, ['shared-read', 'exclusive-write'] as const)
    const writePrefixes = paths(resource.writePrefixes)
    if (mode === 'shared-read' && writePrefixes.length !== 0) throw new HostError('HOST_CONFIG_INVALID', 'read-resource-write-authority')
    return { resourceId: text(resource.resourceId, 128), rootPath: absolute(resource.rootPath), mode,
      protectedRoots: array(resource.protectedRoots, 64).map(absolute), readPrefixes: paths(resource.readPrefixes), writePrefixes,
      maxBaselineFiles: integer(resource.maxBaselineFiles, 0, 10000), maxBaselineBytes: integer(resource.maxBaselineBytes) }
  })
  unique(workspaceResources.map(item => item.resourceId))
  for (const authority of [...parents.map(item => item.capabilities), ...templates.map(item => item.capabilities)]) {
    if (authority.workspaces.some(item => !workspaceResources.some(resource => resource.resourceId === item.resourceId))) throw new HostError('HOST_CONFIG_INVALID', 'workspace-reference')
  }
  return agentJson({ kind: 'enabled', templates, parents, workspaceResources, limits: decodeSubagentLimits(input.limits) }) as HostSubagentConfig
}

export function parentSubagentRole(config: HostSubagentConfig | undefined, agentKey: string): AgentSubagentRole {
  const parent = config?.kind === 'enabled' ? config.parents.find(item => item.agentKey === agentKey) : undefined
  if (parent === undefined) return { role: 'none' }
  const { agentKey: _agent, ...authority } = parent
  return { ...authority, role: 'parent' }
}

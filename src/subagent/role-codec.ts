import { decodeAgentBudget } from '../agent/budget.js'
import { array, choice, eventId, exact, integer, record, text, timestamp, unique } from '../agent/validation.js'
import { workspaceRelativePath } from '../tool/workspace-path.js'
import type { AgentSubagentRole, DelegationCapabilities } from './contract.js'

export function decodeDelegationCapabilities(value: unknown): DelegationCapabilities {
  const input = record(value); exact(input, ['models', 'tools', 'workspaces'])
  const models = array(input.models, 64).map(item => {
    const model = record(item); exact(model, ['providerId', 'model'])
    return { providerId: text(model.providerId, 128), model: text(model.model, 256) }
  })
  unique(models.map(model => JSON.stringify([model.providerId, model.model])))
  const tools = array(input.tools, 64).map(item => text(item, 64)); unique(tools)
  const workspaces = array(input.workspaces, 64).map(item => {
    const workspace = record(item); exact(workspace, ['resourceId', 'modes', 'readPrefixes', 'writePrefixes'])
    const modes = array(workspace.modes, 2).map(mode => choice(mode, ['shared-read', 'exclusive-write'] as const)); unique(modes)
    const paths = (value: unknown) => {
      const paths = array(value, 10000).map(item => workspaceRelativePath(item, 4096))
      unique(paths.map(path => path.toLowerCase())); return paths
    }
    return { resourceId: text(workspace.resourceId, 128), modes, readPrefixes: paths(workspace.readPrefixes), writePrefixes: paths(workspace.writePrefixes) }
  })
  unique(workspaces.map(item => item.resourceId))
  return { models, tools, workspaces }
}

/** Decode the role independently of Agent projection, preventing recursive replay dependencies. */
export function decodeAgentSubagentRole(value: unknown): AgentSubagentRole {
  const input = record(value)
  const role = choice(input.role, ['none', 'parent', 'child'])
  if (role === 'none') { exact(input, ['role']); return { role } }
  if (role === 'parent') {
    exact(input, ['role', 'templates', 'capabilities', 'maxDelegations', 'maxGrant'])
    const templates = array(input.templates, 64).map(item => {
      const template = record(item); exact(template, ['templateKey', 'templateVersion'])
      return { templateKey: text(template.templateKey, 128), templateVersion: integer(template.templateVersion, 1) }
    })
    unique(templates.map(item => JSON.stringify([item.templateKey, item.templateVersion])))
    return { role, templates, capabilities: decodeDelegationCapabilities(input.capabilities),
      maxDelegations: integer(input.maxDelegations), maxGrant: decodeAgentBudget(input.maxGrant) }
  }
  exact(input, ['role', 'bound', 'deadline', 'protocolReserve', 'maxQuestions', 'maxProgress', 'maxFileEntries'])
  return { role, bound: eventId(input.bound), deadline: timestamp(input.deadline), protocolReserve: decodeAgentBudget(input.protocolReserve),
    maxQuestions: integer(input.maxQuestions), maxProgress: integer(input.maxProgress), maxFileEntries: integer(input.maxFileEntries, 0, 10000) }
}

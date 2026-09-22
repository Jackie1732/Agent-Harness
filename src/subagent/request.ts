import { decodeAgentBudget } from '../agent/budget.js'
import { array, choice, exact, integer, record, text, unique } from '../agent/validation.js'
import { boundedJson } from '../schema/bounded-json.js'
import { workspaceRelativePath } from '../tool/workspace-path.js'
import type { DelegationRequest, DelegationWorkspace, SubagentLimits } from './contract.js'
import { SubagentError } from './errors.js'

export const subagentLimitFields = [
  'maxUnresolvedDelegations', 'maxActiveChildren', 'maxChildDurationMs', 'maxProtocolStepsPerBatch',
  'maxRecoveryWrites', 'maxRequestBytes', 'maxMaterialBytes', 'maxResultBytes', 'maxFileEntries',
  'maxProtocolConflicts', 'maxDiscoveryEntries',
] as const

/** Decode all admission ceilings without deriving permissions from ambient resources. */
export function decodeSubagentLimits(value: unknown): SubagentLimits {
  try {
    const input = record(boundedJson(value, { maxBytes: 4096, maxDepth: 4, maxNodes: 64 }))
    exact(input, subagentLimitFields)
    for (const field of subagentLimitFields) integer(input[field])
    integer(input.maxChildDurationMs, 1, 31_536_000_000)
    integer(input.maxProtocolStepsPerBatch, 1)
    integer(input.maxDiscoveryEntries, 1)
    for (const field of ['maxRequestBytes', 'maxMaterialBytes', 'maxResultBytes']) integer(input[field], 1, 1024 * 1024)
    integer(input.maxFileEntries, 0, 10000)
    return input as SubagentLimits
  } catch { throw new SubagentError('SUBAGENT_REQUEST_INVALID', 'invalid-limits') }
}

/** Reject lone surrogates instead of silently replacing them during UTF-8 encoding. */
export function delegationText(value: unknown, maxBytes: number, empty = false): string {
  const result = text(value, maxBytes, empty)
  if (Buffer.from(result, 'utf8').toString('utf8') !== result) throw new SubagentError('SUBAGENT_REQUEST_INVALID', 'invalid-utf8')
  return result
}

function paths(value: unknown, maximum: number): readonly string[] {
  const result = array(value, maximum).map(item => workspaceRelativePath(item, 4096))
  // These paths can be used on Windows as well as case-sensitive hosts.
  unique(result.map(path => path.toLowerCase()))
  return result
}

export function decodeDelegationWorkspace(value: unknown, maxEntries: number): DelegationWorkspace {
  const input = record(value)
  const kind = choice(input.kind, ['none', 'shared-read', 'exclusive-write'])
  if (kind === 'none') { exact(input, ['kind']); return { kind } }
  exact(input, ['kind', 'resourceId', 'readFiles', 'writePrefixes'])
  const resourceId = text(input.resourceId, 128)
  const readFiles = paths(input.readFiles, maxEntries)
  const writePrefixes = paths(input.writePrefixes, maxEntries)
  if (kind === 'shared-read' && writePrefixes.length !== 0) throw new SubagentError('SUBAGENT_REQUEST_INVALID', 'read-only-workspace')
  return { kind, resourceId, readFiles, writePrefixes }
}

/** Snapshot untrusted model/programmatic JSON before any budget or resource acquisition. */
export function decodeDelegationRequest(value: unknown, limits: SubagentLimits): DelegationRequest {
  try {
    const input = record(boundedJson(value, { maxBytes: limits.maxRequestBytes, maxDepth: 12, maxNodes: 100000 }))
    exact(input, ['templateKey', 'templateVersion', 'task', 'materials', 'requestedBudget', 'workspace'])
    const materials = array(input.materials, 10000).map(item => {
      const material = record(item); exact(material, ['label', 'text'])
      return { label: delegationText(material.label, 128), text: delegationText(material.text, limits.maxMaterialBytes, true) }
    })
    const materialBytes = materials.reduce((sum, item) => sum + Buffer.byteLength(item.label) + Buffer.byteLength(item.text), 0)
    if (materialBytes > limits.maxMaterialBytes) throw new Error('material-limit')
    const result: DelegationRequest = {
      templateKey: text(input.templateKey, 128), templateVersion: integer(input.templateVersion, 1),
      task: delegationText(input.task, limits.maxRequestBytes), materials,
      requestedBudget: decodeAgentBudget(input.requestedBudget),
      workspace: decodeDelegationWorkspace(input.workspace, limits.maxFileEntries),
    }
    // A canonical bounded copy freezes nested arrays, budgets and materials as well.
    return boundedJson(result, { maxBytes: limits.maxRequestBytes, maxDepth: 12, maxNodes: 100000 }) as DelegationRequest
  } catch { throw new SubagentError('SUBAGENT_REQUEST_INVALID', 'invalid-request') }
}

import { createHash } from 'node:crypto'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { boundedJson } from '../schema/bounded-json.js'
import type { PreparedToolPlan, ToolDefinition, ToolInvocationLimits, ToolProviderDescriptor, ToolTarget } from './contract.js'
import { decodeDefinition } from './definition.js'
import { ToolError } from './errors.js'
import { argumentBudget, choice, dataField, digest, equalJson, exact, integer, jsonBytes, object, readDescriptor, readLimits, safeCode } from './validation.js'
import { workspaceRelativePath } from './workspace-path.js'

export function schemaLimits(limits: ToolInvocationLimits) {
  return { maxSchemaBytes: limits.maxSchemaBytes, maxSchemaDepth: limits.maxSchemaDepth, maxSchemaNodes: limits.maxSchemaNodes }
}

/** Third-party providers use the same deterministic encoding as the runtime. */
export function createPreparedToolPlan(input: {
  readonly definition: ToolDefinition
  readonly provider: ToolProviderDescriptor
  readonly input: import('../foundation/json.js').JsonValue
  readonly limits: ToolInvocationLimits
  readonly target: ToolTarget
}): PreparedToolPlan {
  const limits = readLimits(input.limits)
  const definition = decodeDefinition(input.definition, schemaLimits(limits))
  const provider = readDescriptor(input.provider)
  if (!provider.tools.some(tool => tool.name === definition.name && tool.version === definition.version)) {
    throw new ToolError('TOOL_BINDING_MISMATCH', 'provider does not support the selected tool version')
  }
  const target = decodeTarget(input.target)
  if ((target.kind === 'logical' ? target.resourceId : target.rootId) !== provider.resourceId) {
    throw new ToolError('TOOL_BINDING_MISMATCH', 'target differs from the selected logical resource')
  }
  const base = {
    version: 1 as const, encoding: 'sorted-json-utf8/v1' as const,
    definition, provider, input: boundedJson(input.input, argumentBudget(limits)), limits, target,
  }
  const fingerprint = createHash('sha256').update(canonicalJsonBytes(base)).digest('hex')
  const plan = { ...base, fingerprint }
  if (jsonBytes(plan) > limits.maxPlanBytes) throw new ToolError('TOOL_RECORD_BUDGET', 'tool plan exceeds its configured byte ceiling')
  return boundedJson(plan, { maxBytes: limits.maxPlanBytes, maxDepth: 128, maxNodes: limits.maxJsonNodes + 2 * limits.maxSchemaNodes + 1024 }) as PreparedToolPlan
}

export function decodeTarget(value: unknown): ToolTarget {
  const copy = object(boundedJson(value, { maxBytes: 32768, maxDepth: 2, maxNodes: 16 }))
  choice(copy.kind, ['logical', 'workspace-file'])
  if (copy.kind === 'logical') { exact(copy, ['kind', 'resourceId']); safeCode(copy.resourceId) }
  else {
    exact(copy, ['kind', 'rootId', 'path', 'maxBytes']); safeCode(copy.rootId)
    workspaceRelativePath(copy.path, 16384); integer(copy.maxBytes)
  }
  return copy as ToolTarget
}

export function decodePlan(value: unknown, expectedLimits?: ToolInvocationLimits): PreparedToolPlan {
  const limits = readLimits(dataField(value, 'limits'))
  // Live provider data is bounded by the consumer's limits, not the limits it claims.
  const budget = expectedLimits === undefined ? limits : readLimits(expectedLimits)
  const copy = object(boundedJson(value, { maxBytes: budget.maxPlanBytes, maxDepth: 128, maxNodes: budget.maxJsonNodes + 2 * budget.maxSchemaNodes + 1024 }))
  exact(copy, ['version', 'encoding', 'definition', 'provider', 'input', 'limits', 'target', 'fingerprint'])
  if (copy.version !== 1 || copy.encoding !== 'sorted-json-utf8/v1') throw new ToolError('TOOL_BINDING_MISMATCH', 'unsupported tool plan version')
  digest(copy.fingerprint)
  const rebuilt = createPreparedToolPlan({
    definition: copy.definition as ToolDefinition, provider: copy.provider as ToolProviderDescriptor,
    input: copy.input!, limits, target: copy.target as ToolTarget,
  })
  if (!equalJson(rebuilt, copy)) throw new ToolError('TOOL_BINDING_MISMATCH', 'tool plan does not match its full canonical content')
  return rebuilt
}

/** Fingerprints never replace a comparison of the entire selected definition and descriptor. */
export function assertPlanBinding(plan: PreparedToolPlan, definition: ToolDefinition, provider: ToolProviderDescriptor,
  input: import('../foundation/json.js').JsonValue, limits: ToolInvocationLimits): void {
  if (!equalJson(plan.definition, definition) || !equalJson(plan.provider, provider)
    || !equalJson(plan.input, input) || !equalJson(plan.limits, limits)) {
    throw new ToolError('TOOL_BINDING_MISMATCH', 'prepared plan changed the selected definition, provider, input, or limits')
  }
}

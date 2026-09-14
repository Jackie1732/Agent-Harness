import { boundedJson } from '../schema/bounded-json.js'
import { validateInlineSchema } from '../schema/inline.js'
import type { ToolDefinition, ToolSchemaLimits } from './contract.js'
import { ToolError } from './errors.js'
import { choice, exact, integer, object, readSchemaLimits, text, toolName } from './validation.js'

/** Freeze the complete definition; only successful output uses outputSchema. */
export function createToolDefinition(value: ToolDefinition, limits: ToolSchemaLimits): ToolDefinition {
  return decodeDefinition(value, limits)
}

export function decodeDefinition(value: unknown, limits: ToolSchemaLimits): ToolDefinition {
  const budget = readSchemaLimits(limits)
  try {
    const copy = object(boundedJson(value, {
      maxBytes: 2 * budget.maxSchemaBytes + 65536 + 1024,
      maxDepth: Math.min(128, budget.maxSchemaDepth + 1), maxNodes: 2 * budget.maxSchemaNodes + 16,
    }))
    exact(copy, ['name', 'version', 'description', 'inputSchema', 'outputSchema', 'operationClass'])
    toolName(copy.name); integer(copy.version); text(copy.description, 65536, true)
    choice(copy.operationClass, ['pure', 'read-only', 'external'])
    for (const name of ['inputSchema', 'outputSchema']) {
      const schema = object(boundedJson(copy[name], {
        maxBytes: budget.maxSchemaBytes, maxDepth: budget.maxSchemaDepth, maxNodes: budget.maxSchemaNodes,
      }))
      validateInlineSchema(schema, 0, budget.maxSchemaDepth)
    }
    if (object(copy.inputSchema).type !== 'object') throw new TypeError('input must be an object schema')
    return copy as ToolDefinition
  } catch {
    throw new ToolError('TOOL_SCHEMA_INVALID', 'tool definition is outside the bounded inline schema contract')
  }
}

import { Ajv2020 } from 'ajv/dist/2020.js'
import type { JsonValue } from '../foundation/json.js'
import { boundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import { validationData, validationSchema } from '../schema/validation-keys.js'
import type { ToolDefinition, ToolInvocationLimits, ToolSchemaLimits } from './contract.js'
import { decodeDefinition } from './definition.js'
import { ToolError } from './errors.js'
import { resultBudget } from './validation.js'

export interface CompiledToolDefinition {
  readonly definition: ToolDefinition
  readonly input: (value: JsonValue) => boolean
  readonly output: (value: JsonValue) => boolean
}

/** A private compiler per registration/projection: no remote loader or global schema cache. */
export function compileDefinition(definition: ToolDefinition, limits: ToolSchemaLimits): CompiledToolDefinition {
  const checked = decodeDefinition(definition, limits)
  try {
    const ajv = new Ajv2020({
      strict: true, ownProperties: true, $data: false, allErrors: false, verbose: false, messages: false,
      coerceTypes: false, useDefaults: false, removeAdditional: false,
      validateSchema: true, addUsedSchema: false, inlineRefs: false,
      loopRequired: 32, loopEnum: 32,
    })
    const input = ajv.compile(validationSchema(checked.inputSchema))
    const output = ajv.compile(validationSchema(checked.outputSchema))
    return Object.freeze({ definition: checked,
      input: (value: JsonValue): boolean => input(validationData(value)) === true,
      output: (value: JsonValue): boolean => output(validationData(value)) === true,
    })
  } catch {
    throw new ToolError('TOOL_SCHEMA_INVALID', 'standard JSON Schema compilation failed')
  }
}

/** Apply the exact success-value budget and the already compiled output schema. */
export function validateToolSuccessValue(
  value: unknown,
  limits: ToolInvocationLimits,
  accepts: CompiledToolDefinition['output'],
): JsonValue {
  try {
    const data = boundedJson(value, resultBudget(limits))
    if (!accepts(data)) throw new ToolError('TOOL_RESULT_INVALID', 'tool success does not satisfy its output schema')
    return data
  } catch (reason) {
    if (reason instanceof ToolError && reason.code === 'TOOL_RESULT_INVALID') throw reason
    throw new ToolError(reason instanceof JsonBoundaryError && reason.reason !== 'invalid'
      ? 'TOOL_RESULT_LIMIT' : 'TOOL_RESULT_INVALID', 'tool success is invalid or exceeds its JSON budget')
  }
}

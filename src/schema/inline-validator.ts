import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { validationData, validationSchema } from './validation-keys.js'

const compiler = new Ajv2020({ strict: true, ownProperties: true, $data: false, allErrors: false,
  coerceTypes: false, useDefaults: false, removeAdditional: false, validateSchema: true, addUsedSchema: false, inlineRefs: false })
const validators = new Map<string, (value: JsonValue) => boolean>()

/** Repeated durable replay shares compiled code by complete schema bytes; cache eviction changes no behavior. */
export function compileInlineValidator(schema: JsonObject): (value: JsonValue) => boolean {
  const key = Buffer.from(canonicalJsonBytes(schema)).toString('utf8')
  const cached = validators.get(key)
  if (cached !== undefined) return cached
  const mapped = validationSchema(schema)
  const validate: ValidateFunction = compiler.compile(mapped)
  compiler.removeSchema(mapped)
  const check = (value: JsonValue) => Boolean(validate(validationData(value)))
  if (validators.size >= 128) validators.delete(validators.keys().next().value!)
  validators.set(key, check)
  return check
}

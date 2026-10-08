import type { JsonObject, JsonValue } from '../foundation/json.js'
import { boundedJson, JsonBoundaryError, parseBoundedJson } from '../schema/bounded-json.js'
import type { JsonValidationLimits } from '../schema/bounded-json.js'
import type { ValidateFunction } from 'ajv'
import { CONTROL_PROTOCOL, CONTROL_VERSION } from './constants.js'
import type { ControlMethod } from './constants.js'
import type { AnyControlRequest } from './envelopes.js'
import { ProtocolError } from './errors.js'
import type { Params } from './methods.js'
import { PARAMS_SCHEMAS } from './params-schemas.js'
import { REQUEST_ENVELOPE_SCHEMA } from './envelope-schemas.js'
import { compileProtocolValidator } from './schema-validator.js'

const envelopeValidator = compileProtocolValidator<{ readonly protocol: typeof CONTROL_PROTOCOL; readonly version: typeof CONTROL_VERSION;
  readonly requestId: string; readonly method: ControlMethod; readonly params: JsonValue }>(REQUEST_ENVELOPE_SCHEMA)
const validators = new Map<ControlMethod, ValidateFunction>()

/** Snapshot JSON and reject configured bytes/depth/nodes before nested decoding. */
export function decodeProtocolJson(value: unknown, limits: JsonValidationLimits): JsonValue {
  try { return boundedJson(value, limits) }
  catch (cause) {
    if (!(cause instanceof JsonBoundaryError)) throw cause
    throw new ProtocolError(cause.reason === 'invalid' ? 'API_PROTOCOL_INVALID' : 'API_LIMIT_EXCEEDED')
  }
}

/** Decode closed method parameters; embedded payload JSON receives the same transport preflight. */
function validateParams<M extends ControlMethod>(method: M, captured: JsonValue, limits: JsonValidationLimits): Params<M> {
  let validate = validators.get(method)
  if (validate === undefined) { validate = compileProtocolValidator(PARAMS_SCHEMAS[method]); validators.set(method, validate) }
  if (!validate(captured)) throw new ProtocolError('API_PROTOCOL_INVALID')
  if ((method === 'message.send' || method === 'message.reply') && captured !== null && typeof captured === 'object' && !Array.isArray(captured)) {
    // The field is a JSON text string, so outer-envelope traversal cannot inspect its nesting.
    try { parseBoundedJson(String((captured as JsonObject).payloadJson), limits) }
    catch (cause) {
      if (!(cause instanceof JsonBoundaryError)) throw cause
      throw new ProtocolError(cause.reason === 'invalid' ? 'API_PROTOCOL_INVALID' : 'API_LIMIT_EXCEEDED')
    }
  }
  // All fields and discriminants were checked by the method's closed schema above.
  return captured as Params<M>
}

/** Decode closed parameters supplied directly by a client or transport adapter. */
export function decodeParams<M extends ControlMethod>(method: M, value: unknown, limits: JsonValidationLimits): Params<M> {
  return validateParams(method, decodeProtocolJson(value, limits), limits)
}

/** Decode a request to the discriminated method/params union before domain admission. */
export function decodeControlRequest(value: unknown, limits: JsonValidationLimits): AnyControlRequest {
  const captured = decodeProtocolJson(value, limits)
  if (captured !== null && typeof captured === 'object' && !Array.isArray(captured)
    && (captured as JsonObject).protocol === CONTROL_PROTOCOL && typeof (captured as JsonObject).version === 'number'
    && (captured as JsonObject).version !== CONTROL_VERSION) throw new ProtocolError('API_VERSION_UNSUPPORTED')
  if (!envelopeValidator(captured)) throw new ProtocolError('API_PROTOCOL_INVALID')
  const params = validateParams(captured.method, captured.params, limits)
  return Object.freeze({ ...captured, params }) as AnyControlRequest
}

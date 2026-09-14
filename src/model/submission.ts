import { createHash } from 'node:crypto'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { ModelProviderDescriptor, ModelRequest, PreparedSubmission } from './contract.js'
import { ModelError } from './errors.js'
import { snapshotModelRequest } from './request.js'
import { bool, boundedIdentifier, integer, keys, list, object, text } from './validation.js'

const ENCODING = 'sorted-json-utf8/v1' as const
const SENSITIVE_HEADERS = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i

/** Validate the safe descriptor independently of a live adapter or credentials. */
export function decodeProviderDescriptor(value: JsonValue): ModelProviderDescriptor {
  const binding = object(value, 'provider descriptor')
  keys(binding, ['providerId', 'protocol', 'adapterVersion', 'endpoint', 'semanticHeaders', 'support', 'streamLimits', 'maxConcurrentExchanges'])
  for (const field of ['providerId', 'protocol', 'adapterVersion'] as const) boundedIdentifier(binding[field], field)
  const endpoint = text(binding.endpoint, 'endpoint identity', 2048, false)
  let url: URL
  try { url = new URL(endpoint) }
  catch { throw new ModelError('MODEL_REQUEST_INVALID', 'endpoint identity must be an absolute URI') }
  if (url.username || url.password || url.search || url.hash) {
    throw new ModelError('MODEL_REQUEST_INVALID', 'endpoint must not contain credentials, query parameters, or fragment')
  }
  const headers = object(binding.semanticHeaders, 'semantic headers')
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || SENSITIVE_HEADERS.test(name)) {
      throw new ModelError('MODEL_REQUEST_INVALID', 'semantic header name is not permitted')
    }
    const header = text(value, 'semantic header', 256, false)
    if (/[\r\n\0]/.test(header)) throw new ModelError('MODEL_REQUEST_INVALID', 'semantic header is not a single line')
  }
  const support = object(binding.support, 'model support')
  keys(support, ['text', 'instructions', 'tools', 'controls', 'profiles', 'continuations'])
  for (const field of ['text', 'instructions', 'tools'] as const) bool(support[field], field)
  const controls = list(support.controls, 'supported controls')
  if (controls.some(control => control !== 'temperature' && control !== 'topP') || new Set(controls).size !== controls.length) {
    throw new ModelError('MODEL_REQUEST_INVALID', 'supported controls are invalid')
  }
  for (const field of ['profiles', 'continuations'] as const) {
    const names = list(support[field], field).map(name => text(name, field, 128, false))
    if (new Set(names).size !== names.length) throw new ModelError('MODEL_REQUEST_INVALID', 'supported namespaces repeat')
  }
  const limits = object(binding.streamLimits, 'stream limits')
  keys(limits, ['maxFrameBytes', 'maxStreamBytes', 'maxFrames'])
  for (const field of ['maxFrameBytes', 'maxStreamBytes', 'maxFrames'] as const) integer(limits[field], field, 1)
  integer(binding.maxConcurrentExchanges, 'maxConcurrentExchanges', 1)
  return binding as ModelProviderDescriptor
}

function assertSupported(request: ModelRequest, binding: ModelProviderDescriptor): void {
  const support = binding.support
  if (!support.text || request.instructions.length > 0 && !support.instructions || request.tools.length > 0 && !support.tools) {
    throw new ModelError('MODEL_FEATURE_UNSUPPORTED', 'selected binding cannot represent the requested content')
  }
  for (const control of ['temperature', 'topP'] as const) {
    if (request[control] !== undefined && !support.controls.includes(control)) {
      throw new ModelError('MODEL_FEATURE_UNSUPPORTED', 'selected binding does not support the requested control')
    }
  }
  if (request.profile !== undefined && !support.profiles.includes(`${request.profile.namespace}@${request.profile.version}`)) {
    throw new ModelError('MODEL_FEATURE_UNSUPPORTED', 'request profile is not supported by this binding')
  }
  for (const message of request.messages) {
    if (!support.tools && message.content.some(block => block.kind !== 'text')) {
      throw new ModelError('MODEL_FEATURE_UNSUPPORTED', 'selected binding does not support tool history')
    }
    if (message.role === 'assistant' && message.continuation !== undefined) {
      const capsule = message.continuation
      if (!support.continuations.includes(`${capsule.namespace}@${capsule.version}`)
        || capsule.providerId !== binding.providerId || capsule.model !== request.model) {
        throw new ModelError('MODEL_FEATURE_UNSUPPORTED', 'continuation is incompatible with the selected binding')
      }
    }
  }
}

/** Build a complete, bounded-by-the-consumer submission for a provider implementation. */
export function createPreparedSubmission(
  requestInput: ModelRequest,
  descriptorInput: ModelProviderDescriptor,
  wireBodyInput: JsonObject,
): PreparedSubmission {
  const request = snapshotModelRequest(requestInput)
  const binding = decodeProviderDescriptor(snapshotJson(descriptorInput))
  assertSupported(request, binding)
  const wireBody = object(snapshotJson(wireBodyInput), 'wire body')
  const unsigned = { version: 1, encoding: ENCODING, request, binding, wireBody } as const
  const fingerprint = createHash('sha256').update(canonicalJsonBytes(unsigned)).digest('hex')
  return snapshotJson({ ...unsigned, fingerprint }) as PreparedSubmission
}

/** Decode old prepared facts without loading their original adapter. */
export function decodePreparedSubmission(value: JsonValue): PreparedSubmission {
  const input = object(value, 'prepared submission')
  keys(input, ['version', 'encoding', 'request', 'binding', 'wireBody', 'fingerprint'])
  if (input.version !== 1 || input.encoding !== ENCODING) {
    throw new ModelError('MODEL_REQUEST_INVALID', 'prepared submission version or encoding is unsupported')
  }
  const request = snapshotModelRequest(input.request)
  const binding = decodeProviderDescriptor(object(input.binding, 'provider binding'))
  const result = createPreparedSubmission(request, binding, object(input.wireBody, 'wire body'))
  if (result.fingerprint !== input.fingerprint) throw new ModelError('MODEL_STATE_INVALID', 'prepared submission fingerprint does not match its complete content')
  return result
}

/** Reconstruct exactly the body submitted by this plan, without network or credentials. */
export function encodeModelWireBody(submission: PreparedSubmission): Uint8Array {
  return canonicalJsonBytes(decodePreparedSubmission(submission).wireBody)
}

/** A digest comparison is never substituted for complete prepared-content equality. */
export function assertSameSubmission(expected: PreparedSubmission, committed: PreparedSubmission): void {
  if (!Buffer.from(canonicalJsonBytes(expected)).equals(Buffer.from(canonicalJsonBytes(committed)))) {
    throw new ModelError('MODEL_BINDING_MISMATCH', 'committed submission differs from its captured provider binding')
  }
}

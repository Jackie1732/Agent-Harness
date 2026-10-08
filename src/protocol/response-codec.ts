import { createHash } from 'node:crypto'
import type { ValidateFunction } from 'ajv'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { decodeStoredSessionEvent } from '../session/codec.js'
import { parseSessionAddress, parseSessionEventId } from '../session/ids.js'
import type { JsonValidationLimits } from '../schema/bounded-json.js'
import { CONTROL_PROTOCOL, CONTROL_VERSION } from './constants.js'
import type { ControlMethod } from './constants.js'
import type { ControlError, ControlResponse } from './envelopes.js'
import type { RequestId } from './references.js'
import { API_HTTP_STATUS, ProtocolError } from './errors.js'
import { RESULT_SCHEMAS, STORED_EVENT_SCHEMA } from './result-schemas.js'
import { decodeProtocolJson } from './request-codec.js'
import { ERROR_ENVELOPE_SCHEMA, RESULT_ENVELOPE_SCHEMA } from './envelope-schemas.js'
import { compileProtocolValidator } from './schema-validator.js'
import type { Result } from './methods.js'

const errorValidator = compileProtocolValidator<ControlError>(ERROR_ENVELOPE_SCHEMA)
const validators = new Map<ControlMethod, ValidateFunction<Result<ControlMethod>>>()
const resultEnvelopeValidator = compileProtocolValidator<{ readonly protocol: typeof CONTROL_PROTOCOL; readonly version: typeof CONTROL_VERSION;
  readonly requestId: RequestId; readonly kind: 'result'; readonly result: JsonValue }>(RESULT_ENVELOPE_SCHEMA)

function invalid(): never { throw new ProtocolError('API_PROTOCOL_INVALID', 'Invalid control response') }

function validateReferences(value: JsonValue): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const item of value) validateReferences(item); return }
  const item = value as JsonObject
  if (Object.hasOwn(item, 'cuts')) {
    const cuts = item.cuts as readonly { readonly sessionId: string; readonly through: number }[]
    if (new Set(cuts.map(cut => cut.sessionId)).size !== cuts.length) invalid()
  }
  if (Object.hasOwn(item, 'envelopeVersion') && Object.hasOwn(item, 'eventId')) {
    try { decodeStoredSessionEvent(Buffer.from(JSON.stringify(item), 'utf8')) } catch { invalid() }
  }
  if (typeof item.address === 'string' && typeof item.eventId === 'string'
    && parseSessionAddress(item.address) !== parseSessionEventId(item.eventId).sessionId) invalid()
  for (const [key, child] of Object.entries(item)) {
    // Payload/value are user JSON, so their field names do not acquire protocol semantics.
    if (key !== 'payload' && key !== 'value') validateReferences(child)
  }
}

function checkFinal(final: { readonly text: string | null; readonly textBytes: number; readonly textOmitted: boolean } | null): void {
  if (final === null) return
  if (final.textOmitted ? final.text !== null : final.text === null || Buffer.byteLength(final.text) !== final.textBytes) invalid()
}

function checkResult<M extends ControlMethod>(method: M, value: Result<M>): void {
  if (method === 'root.get' || method === 'root.wait') {
    const root = (method === 'root.get' ? value : (value as Result<'root.wait'>).observation) as Result<'root.get'>
    if (root.outcome === 'completed' ? root.final === null : root.final !== null) invalid()
    checkFinal(root.final)
  }
  if (method === 'input.get') {
    const input = value as Result<'input.get'>
    if ((input.kind === 'answer') !== (input.wait !== null)) invalid()
  }
  if (method === 'workflow.artifact') {
    const artifact = value as Result<'workflow.artifact'>
    if (Buffer.byteLength(artifact.text) !== artifact.byteLength || createHash('sha256').update(artifact.text, 'utf8').digest('hex') !== artifact.sha256) invalid()
  }
  if (method === 'session.events') {
    const page = value as Result<'session.events'>
    if (page.hasMore !== (page.nextCursor !== null)) invalid()
    let prior: number | undefined
    for (const event of page.events) {
      if (event.sessionId !== page.sessionId || event.sequence > page.through || prior !== undefined && event.sequence !== prior + 1) invalid()
      prior = event.sequence
    }
    const next = page.nextCursor
    if (page.hasMore && page.events.length === 0 || !page.hasMore && prior !== undefined && prior !== page.through) invalid()
    if (next !== null && (next.sessionId !== page.sessionId || next.through !== page.through
      || next.nextSequence > page.through || prior !== undefined && next.nextSequence !== prior + 1)) invalid()
  }
}

/** Validate a result before serialization or accepting a successful server response. */
function validateResult<M extends ControlMethod>(method: M, captured: JsonValue): Result<M> {
  let validate = validators.get(method)
  if (validate === undefined) {
    validate = compileProtocolValidator<Result<ControlMethod>>({ ...RESULT_SCHEMAS[method], $defs: { storedEvent: STORED_EVENT_SCHEMA } })
    validators.set(method, validate)
  }
  const unknownValue: unknown = captured
  if (!validate(unknownValue)) invalid()
  validateReferences(captured)
  const result = unknownValue as Result<M>
  checkResult(method, result)
  return result
}

/** Validate a standalone result against the selected method and configured JSON budgets. */
export function decodeResult<M extends ControlMethod>(method: M, value: unknown, limits: JsonValidationLimits): Result<M> {
  return validateResult(method, decodeProtocolJson(value, limits))
}

/** Validate protocol, correlation, HTTP status and the selected method's entire result. */
export function decodeControlResponse<M extends ControlMethod>(method: M, value: unknown, expectedRequestId: string,
  httpStatus: number, limits: JsonValidationLimits): ControlResponse<M> {
  const captured: unknown = decodeProtocolJson(value, limits)
  if (errorValidator(captured)) {
    if (captured.requestId !== expectedRequestId && !(captured.requestId === null && captured.error.acceptance === 'not-accepted')) invalid()
    if (httpStatus !== API_HTTP_STATUS[captured.error.code]) invalid()
    return captured
  }
  if (!resultEnvelopeValidator(captured) || captured.requestId !== expectedRequestId || httpStatus !== 200) invalid()
  // The complete envelope was already bounded and copied; validate the captured result in place.
  return Object.freeze({ ...captured, result: validateResult(method, captured.result) })
}

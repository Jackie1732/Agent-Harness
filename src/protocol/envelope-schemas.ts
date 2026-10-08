import { CONTROL_METHODS, CONTROL_PROTOCOL, CONTROL_VERSION } from './constants.js'
import { API_HTTP_STATUS } from './errors.js'
import { choice, literal, nameSchema, nullable, object, requestIdSchema, stringSchema } from './schema-fields.js'

/** Closed wire envelopes shared by transport codecs and language SDK generators. */
export const REQUEST_ENVELOPE_SCHEMA = object({
  protocol: literal(CONTROL_PROTOCOL), version: literal(CONTROL_VERSION), requestId: requestIdSchema,
  method: choice(CONTROL_METHODS), params: {},
})
export const RESULT_ENVELOPE_SCHEMA = object({
  protocol: literal(CONTROL_PROTOCOL), version: literal(CONTROL_VERSION), requestId: requestIdSchema,
  kind: literal('result'), result: {},
})
export const ERROR_ENVELOPE_SCHEMA = object({
  protocol: literal(CONTROL_PROTOCOL), version: literal(CONTROL_VERSION), requestId: nullable(requestIdSchema),
  kind: literal('error'), error: object({ code: choice(Object.keys(API_HTTP_STATUS)),
    message: { ...nameSchema, maxUtf8Bytes: 1024 }, acceptance: choice(['not-accepted', 'unknown', 'not-applicable']),
    domainCode: nullable({ ...stringSchema, minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }) }),
})

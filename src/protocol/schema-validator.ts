import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import type { JsonObject } from '../foundation/json.js'
import { isCanonicalIsoTimestamp, isCanonicalUuid } from '../foundation/protocol-scalars.js'
import { parseSessionAddress, parseSessionEventId } from '../session/ids.js'

/** The compiler only validates closed control data; it never coerces or deletes fields. */
const compiler = new Ajv2020({ strict: true, ownProperties: true, allErrors: false, coerceTypes: false,
  useDefaults: false, removeAdditional: false, addUsedSchema: false, inlineRefs: false })
compiler.addFormat('canonical-uuid', isCanonicalUuid)
compiler.addFormat('iso-timestamp', isCanonicalIsoTimestamp)
compiler.addFormat('session-event-id', value => { try { parseSessionEventId(value); return true } catch { return false } })
compiler.addFormat('session-address', value => { try { parseSessionAddress(value); return true } catch { return false } })
compiler.addKeyword({ keyword: 'maxUtf8Bytes', type: 'string', schemaType: 'number',
  validate: (maximum: number, value: string) => Buffer.byteLength(value, 'utf8') <= maximum })

/** A successful Ajv validation narrows unknown data to the specified pure data declaration. */
export function compileProtocolValidator<T>(schema: JsonObject): ValidateFunction<T> { return compiler.compile<T>(schema) }

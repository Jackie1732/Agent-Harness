import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import { snapshotJson } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'
import { createMessageCatalog, createMessageDefinition } from '../communication/message-catalog.js'
import type { MessageCatalog, MessageDefinition } from '../communication/message-catalog.js'
import type { HostMessageConfig } from './config.js'
import { HostError } from './errors.js'

function invalidSchema(message: HostMessageConfig, errors: readonly ErrorObject[] | null | undefined): never {
  const keyword = errors?.[0]?.keyword ?? 'validation'
  throw new HostError('HOST_PROTOCOL_INVALID', 'message-payload-invalid', {
    type: message.type,
    payloadVersion: message.payloadVersion,
    keyword,
  })
}

function decoder(message: HostMessageConfig, validate: ValidateFunction): (value: JsonValue) => JsonValue {
  return value => {
    const copy = snapshotJson(value)
    if (!validate(copy)) invalidSchema(message, validate.errors)
    return copy
  }
}

/** Compile the saved inline message schemas without remote references or code loading. */
export function compileHostMessageCatalog(messages: readonly HostMessageConfig[]): MessageCatalog {
  const ajv = new Ajv2020({ allErrors: false, strict: true, validateSchema: true })
  const definitions: MessageDefinition[] = messages.map(message => {
    let validate: ValidateFunction
    try { validate = ajv.compile(message.schema) }
    catch (cause) {
      throw new HostError('HOST_CONFIG_INVALID', 'message-schema-compile-failed', {
        type: message.type,
        payloadVersion: message.payloadVersion,
      }, { cause })
    }
    return createMessageDefinition({
      type: message.type,
      payloadVersion: message.payloadVersion,
      decode: decoder(message, validate),
    })
  })
  return createMessageCatalog(definitions)
}

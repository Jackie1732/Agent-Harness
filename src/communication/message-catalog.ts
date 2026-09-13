import { snapshotJson } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'
import { CommunicationError } from './errors.js'

const MESSAGE_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/
const MAX_MESSAGE_TYPE_LENGTH = 128

/** Runtime definition of one versioned Message payload. */
export interface MessageDefinition<TPayload extends JsonValue = JsonValue> {
  readonly type: string
  readonly payloadVersion: number
  /** Decode and normalize one JSON payload. */
  readonly decode: (value: JsonValue) => TPayload
}

/** Construction fields for one immutable Message Definition. */
export interface MessageDefinitionOptions<TPayload extends JsonValue> {
  readonly type: string
  readonly payloadVersion: number
  readonly decode: (value: JsonValue) => TPayload
}

/** Immutable exact-version Message Definition registry. */
export interface MessageCatalog {
  /** Resolve one exact Message type and payload version. */
  resolve(type: string, payloadVersion: number): MessageDefinition | undefined
  /** Check whether this Catalog contains the exact Definition object. */
  contains(definition: MessageDefinition): boolean
}

/** Validate one canonical Message protocol type name. */
export function validateMessageType(type: string): string {
  if (type.length > MAX_MESSAGE_TYPE_LENGTH || !MESSAGE_TYPE_PATTERN.test(type)) {
    throw new CommunicationError('MESSAGE_DEFINITION_INVALID', 'message type is not canonical', {
      details: { type },
    })
  }
  return type
}

/** Validate one positive exact Message payload version. */
export function validateMessagePayloadVersion(payloadVersion: number): number {
  if (!Number.isSafeInteger(payloadVersion) || payloadVersion < 1) {
    throw new CommunicationError(
      'MESSAGE_DEFINITION_INVALID',
      'message payloadVersion must be a positive safe integer',
      { details: { payloadVersion } },
    )
  }
  return payloadVersion
}

/** Create one validated immutable Message Definition. */
export function createMessageDefinition<TPayload extends JsonValue>(
  options: MessageDefinitionOptions<TPayload>,
): MessageDefinition<TPayload> {
  validateMessageType(options.type)
  validateMessagePayloadVersion(options.payloadVersion)
  if (typeof options.decode !== 'function') {
    throw new CommunicationError('MESSAGE_DEFINITION_INVALID', 'message definition requires a decoder', {
      details: { type: options.type, payloadVersion: options.payloadVersion },
    })
  }
  return Object.freeze({
    type: options.type,
    payloadVersion: options.payloadVersion,
    decode: options.decode,
  })
}

function definitionKey(type: string, payloadVersion: number): string {
  return `${type}\u0000${payloadVersion}`
}

/** Create an immutable Catalog from exact Message Definition identities. */
export function createMessageCatalog(
  definitions: readonly MessageDefinition[] = [],
): MessageCatalog {
  const byKey = new Map<string, MessageDefinition>()
  const identities = new Set<MessageDefinition>()
  for (const definition of definitions) {
    validateMessageType(definition.type)
    validateMessagePayloadVersion(definition.payloadVersion)
    if (typeof definition.decode !== 'function') {
      throw new CommunicationError('MESSAGE_DEFINITION_INVALID', 'message definition requires a decoder', {
        details: { type: definition.type, payloadVersion: definition.payloadVersion },
      })
    }
    Object.freeze(definition)
    const key = definitionKey(definition.type, definition.payloadVersion)
    const existing = byKey.get(key)
    if (existing !== undefined && existing !== definition) {
      throw new CommunicationError(
        'MESSAGE_DEFINITION_CONFLICT',
        `conflicting message definition for ${definition.type}@${definition.payloadVersion}`,
        { details: { type: definition.type, payloadVersion: definition.payloadVersion } },
      )
    }
    byKey.set(key, definition)
    identities.add(definition)
  }
  return Object.freeze({
    resolve: (type: string, payloadVersion: number) => byKey.get(definitionKey(type, payloadVersion)),
    contains: (definition: MessageDefinition) => identities.has(definition),
  })
}

/** Decode, copy, and freeze a payload with one exact Message Definition. */
export function decodeMessagePayload<TPayload extends JsonValue>(
  definition: MessageDefinition<TPayload>,
  payload: JsonValue,
): TPayload {
  try {
    const input = snapshotJson(payload, 'message payload')
    return snapshotJson(definition.decode(input), 'decoded message payload') as TPayload
  } catch {
    throw new CommunicationError('MESSAGE_PAYLOAD_INVALID', 'message payload failed its definition', {
      details: { type: definition.type, payloadVersion: definition.payloadVersion },
    })
  }
}

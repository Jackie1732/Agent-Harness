import {
  createDurableEventCatalog,
  createDurableEventDefinition,
  MemorySessionBackend,
  parseSessionId,
  SessionRepository,
} from '../../src/index.js'
import type {
  CommittedSessionEvent,
  JsonObject,
  JsonValue,
  SessionIdentitySource,
  SessionProjection,
} from '../../src/index.js'

export interface Delta extends JsonObject {
  readonly value: number
}

export function deltaDecoder(value: JsonValue): Delta {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('delta must be an object')
  }
  const object = value as JsonObject
  if (Object.keys(object).length !== 1 || typeof object.value !== 'number') {
    throw new TypeError('delta.value must be the only numeric field')
  }
  return { value: object.value }
}

export const deltaEvent = createDurableEventDefinition<Delta>({
  type: 'test/delta',
  payloadVersion: 1,
  ignorable: false,
  decode: deltaDecoder,
})

export function identities(...values: readonly string[]): SessionIdentitySource {
  let index = 0
  return {
    nextSessionId: () => {
      const value = values[index]
      if (value === undefined) throw new Error('identity fixture exhausted')
      index += 1
      return parseSessionId(value)
    },
  }
}

export const firstId = '00000000-0000-4000-8000-000000000011'
export const secondId = '00000000-0000-4000-8000-000000000012'

export function createTestRepository(
  identitySource: SessionIdentitySource = identities(firstId, secondId),
): SessionRepository {
  return new SessionRepository({
    backend: new MemorySessionBackend({ maxRecordBytes: 4096 }),
    catalog: createDurableEventCatalog([deltaEvent]),
    maxLineageDepth: 4,
    clock: { now: () => 1_789_257_600_000 },
    identitySource,
  })
}

export const sumProjection: SessionProjection<number> = Object.freeze({
  name: 'sum',
  initial: () => 0,
  apply: (state: number, event: CommittedSessionEvent) => state + (event.stored.type === deltaEvent.type
    ? (event.payload as Delta).value
    : 0),
})

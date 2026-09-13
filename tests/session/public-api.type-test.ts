import {
  FileSessionBackend,
  MemorySessionBackend,
  SessionRepository,
  createDurableEventCatalog,
  createDurableEventDefinition,
  formatSessionAddress,
  parseSessionId,
} from '../../src/index.js'
import type {
  DurableEventDefinition,
  JsonObject,
  SessionAddress,
  SessionBackend,
  SessionHandle,
  SessionId,
  SessionLogPosition,
  SessionProjection,
  SessionSequence,
} from '../../src/index.js'

const definition: DurableEventDefinition<JsonObject> = createDurableEventDefinition({
  type: 'type/check',
  payloadVersion: 1,
  ignorable: false,
  decode: value => value as JsonObject,
})
const memory: SessionBackend = new MemorySessionBackend({ maxRecordBytes: 1024 })
const file: SessionBackend = new FileSessionBackend({ root: 'C:\\sessions', maxRecordBytes: 1024 })
const repository = new SessionRepository({
  backend: memory,
  catalog: createDurableEventCatalog([definition]),
  maxLineageDepth: 2,
})
const projection: SessionProjection<number> = {
  name: 'count',
  initial: () => 0,
  apply: state => state + 1,
}

declare const handle: SessionHandle
void handle.append(definition, {})
void handle.supportsEventDefinition(definition)
void handle.project(projection)
void formatSessionAddress(parseSessionId('00000000-0000-4000-8000-000000000001'))
void repository
void file

declare const typedId: SessionId
declare const typedAddress: SessionAddress
declare const typedPosition: SessionLogPosition
declare const typedSequence: SessionSequence

// @ts-expect-error Session address and identity remain distinct at package boundaries.
const invalidId: SessionId = typedAddress
// @ts-expect-error Sequence and committed-prefix position carry different semantics.
const invalidSequence: SessionSequence = typedPosition
// @ts-expect-error Projection state must be representable as JSON.
const invalidProjection: SessionProjection<Date> = { name: 'invalid', initial: () => new Date(), apply: state => state }
void typedId
void typedSequence
void invalidId
void invalidSequence
void invalidProjection

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileSessionBackend,
  MemorySessionBackend,
  SessionRepository,
  createDurableEventCatalog,
  createDurableEventDefinition,
  sessionLogPosition,
} from '../../src/index.js'
import type { JsonObject, JsonValue, SessionProjection, SessionSnapshot } from '../../src/index.js'

interface Measurement extends JsonObject {
  readonly version: 1
  readonly unit: 'fahrenheit'
  readonly temperature: number
}

function measurementDefinition() {
  return createDurableEventDefinition<Measurement>({
    type: 'measurement/recorded', payloadVersion: 1, ignorable: false,
    decode: value => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('measurement requires an object')
      const input = value as JsonObject
      if (Object.keys(input).length !== 3 || input.version !== 1 || typeof input.temperature !== 'number'
        || input.unit !== 'celsius' && input.unit !== 'fahrenheit') throw new TypeError('measurement fields are invalid')
      return {
        version: 1, unit: 'fahrenheit',
        temperature: input.unit === 'celsius' ? input.temperature * 1.8 + 32 : input.temperature,
      }
    },
  })
}

const celsius = (temperature: number): JsonValue => ({ version: 1, unit: 'celsius', temperature })
const freezing: Measurement = { version: 1, unit: 'fahrenheit', temperature: 32 }
const sharedScale: Measurement = { version: 1, unit: 'fahrenheit', temperature: -40 }

const projection: SessionProjection<readonly JsonValue[]> = {
  name: 'measurements', initial: () => [],
  apply: (state, event) => event.stored.type === 'measurement/recorded' ? [...state, event.payload] : state,
}

function assertCanonical(snapshot: SessionSnapshot, expected: readonly Measurement[]): void {
  const records = snapshot.history.flatMap(segment => segment.events)
  expect(records).toHaveLength(expected.length)
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    expect(record?.kind).toBe('known')
    if (record?.kind !== 'known') throw new Error('measurement was not decoded')
    expect(record.payload).toEqual(expected[index])
    expect(record.stored.payload).toEqual(record.payload)
  }
}

describe('canonical durable payloads', () => {
  it('preserves marked normalization across Memory reads and inherited Fork prefixes', async () => {
    const definition = measurementDefinition()
    const repository = new SessionRepository({
      backend: new MemorySessionBackend({ maxRecordBytes: 4096 }),
      catalog: createDurableEventCatalog([definition]), maxLineageDepth: 2,
    })
    try {
      const parent = await repository.create()
      const committed = await parent.append(definition, celsius(0))
      expect(committed.payload).toEqual(freezing)
      expect(definition.decode(committed.payload)).toEqual(committed.payload)
      await parent.append(definition, celsius(100))
      assertCanonical(await repository.read(parent.header.sessionId), [freezing, { version: 1, unit: 'fahrenheit', temperature: 212 }])
      const child = await repository.fork(parent.header.sessionId, sessionLogPosition(1))
      await child.append(definition, celsius(-40))

      assertCanonical(child.snapshot(), [freezing, sharedScale])
      expect(child.project(projection).state).toEqual([freezing, sharedScale])
      assertCanonical(await repository.read(child.header.sessionId), [freezing, sharedScale])
    } finally {
      await repository.dispose()
    }
  })

  it('reopens the same File facts through fresh Backend, Repository, Catalog and Definition instances', async () => {
    const temporaryParent = tmpdir()
    const root = await mkdtemp(join(temporaryParent, 'atomic-harness-normalization-'))
    const firstDefinition = measurementDefinition()
    let repository = new SessionRepository({
      backend: new FileSessionBackend({ root, maxRecordBytes: 4096 }),
      catalog: createDurableEventCatalog([firstDefinition]), maxLineageDepth: 2,
    })
    try {
      const parent = await repository.create()
      await parent.append(firstDefinition, celsius(0))
      const child = await repository.fork(parent.header.sessionId, sessionLogPosition(1))
      await child.append(firstDefinition, celsius(-40))
      const before = child.snapshot()
      const result = child.project(projection)
      const id = child.header.sessionId
      await repository.dispose()
      const freshDefinition = measurementDefinition()
      repository = new SessionRepository({
        backend: new FileSessionBackend({ root, maxRecordBytes: 4096 }),
        catalog: createDurableEventCatalog([freshDefinition]), maxLineageDepth: 2,
      })

      const reopened = await repository.open(id)
      expect(reopened.snapshot()).toEqual(before)
      expect(reopened.project({ ...projection })).toEqual(result)
      expect(reopened.supportsEventDefinition(firstDefinition)).toBe(false)
      expect(reopened.supportsEventDefinition(freshDefinition)).toBe(true)
      assertCanonical(reopened.snapshot(), [freezing, sharedScale])
    } finally {
      try {
        await repository.dispose()
      } finally {
        expect(dirname(root)).toBe(temporaryParent)
        await rm(root, { recursive: true, force: true })
      }
    }
  })
})

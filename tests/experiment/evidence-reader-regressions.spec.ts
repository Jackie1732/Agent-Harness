import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { createDurableEventCatalog, createDurableEventDefinition } from '../../src/session/event-catalog.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { sessionLogPosition } from '../../src/session/ids.js'
import { SessionRepository } from '../../src/session/repository.js'
import { collectExperimentEvidence } from '../../src/experiment/evidence.js'
import { decodeExperimentEvidence } from '../../src/experiment/evidence-codec.js'
import { hostConfig } from '../host/fixtures.js'

const limits = { maxSessionCount: 2, maxEvents: 100, maxEvidenceBytes: 1024 * 1024, maxMetricSamples: 100 }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const externalEvent = createDurableEventDefinition({ type: 'outside-harness/recorded', payloadVersion: 1, ignorable: false, decode: value => value })

async function source() {
  const base = await mkdtemp(join(tmpdir(), 'atomic-evidence-selected-cut-'))
  roots.push(base)
  const recipe = resolveHostConfig(decodeHostConfig(hostConfig(join(base, 'store')), base))
  const repository = new SessionRepository({ backend: new FileSessionBackend(recipe.storage),
    catalog: createDurableEventCatalog([externalEvent]), maxLineageDepth: recipe.storage.maxLineageDepth })
  return { recipe, repository }
}

describe('observed experiment evidence cuts', () => {
  for (const failure of ['unsupported-event', 'unavailable-position'] as const) {
    it(`retains a failed ${failure} selection without declaring its requested cut observed`, async () => {
      const { recipe, repository } = await source()
      const session = await repository.create()
      const sessionId = session.header.sessionId
      if (failure === 'unsupported-event') await session.append(externalEvent, { value: 'outside the inspection catalog' })
      await repository.dispose()
      const logPath = join(recipe.storage.root, 'sessions', sessionId, 'events.log')
      const before = await readFile(logPath)
      const { evidence, snapshots } = await collectExperimentEvidence({ recipe, limits, scope: 'historical-local/v1', mode: 'historical',
        selected: [{ sessionId, through: sessionLogPosition(1) }] })
      const reason = failure === 'unsupported-event' ? 'SESSION_EVENT_UNSUPPORTED' : 'SESSION_POSITION_INVALID'
      expect(evidence.coverage).toEqual({ complete: false, expectedSessions: 1, observedSessions: 0, reasons: [reason] })
      expect(evidence.selections).toEqual([{ sessionId, through: null }])
      expect(evidence.sessions).toEqual([])
      expect(snapshots).toEqual([])
      expect(evidence.metrics.coverage.reasons).toContain(`selected-session-missing:${sessionId}`)
      expect(decodeExperimentEvidence(JSON.parse(JSON.stringify(evidence)), limits)).toEqual(evidence)
      expect((await readFile(logPath)).equals(before)).toBe(true)
    })
  }

  it('keeps a successfully observed zero cut separate from a failed requested cut', async () => {
    const { recipe, repository } = await source()
    const failed = await repository.create(), observed = await repository.create()
    await failed.append(externalEvent, { value: 'outside the inspection catalog' })
    await observed.end('later physical fact')
    await repository.dispose()
    const { evidence, snapshots } = await collectExperimentEvidence({ recipe, limits, scope: 'historical-local/v1', mode: 'historical', selected: [
      { sessionId: failed.header.sessionId, through: sessionLogPosition(1) },
      { sessionId: observed.header.sessionId, through: sessionLogPosition(0) },
    ] })
    expect(evidence.coverage).toMatchObject({ complete: false, expectedSessions: 2, observedSessions: 1 })
    expect(evidence.selections.find(item => item.sessionId === failed.header.sessionId)?.through).toBeNull()
    expect(evidence.selections.find(item => item.sessionId === observed.header.sessionId)?.through).toBe(0)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.localPosition).toBe(0)
    expect(evidence.sessions[0]).toMatchObject({ sessionId: observed.header.sessionId, through: 0, committedBytes: 0 })
    expect(evidence.sessions[0]!.log.byteLength).toBeGreaterThan(0)
    expect(decodeExperimentEvidence(JSON.parse(JSON.stringify(evidence)), limits)).toEqual(evidence)
  })
})

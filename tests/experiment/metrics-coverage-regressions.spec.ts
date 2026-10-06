import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { createDurableEventCatalog, createDurableEventDefinition } from '../../src/session/event-catalog.js'
import { sessionLogPosition } from '../../src/session/ids.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { collectExperimentEvidence } from '../../src/experiment/evidence.js'
import { collectExperimentMetrics } from '../../src/experiment/metrics.js'
import { decodeExperimentMetrics } from '../../src/experiment/metrics-codec.js'
import { decodeExperimentEvidence } from '../../src/experiment/evidence-codec.js'
import { hostConfig } from '../host/fixtures.js'

describe('experiment metric coverage reason limits', () => {
  it('decodes the metrics of two differently unreadable selected Session cuts', async () => {
    const base = await mkdtemp(join(tmpdir(), 'atomic-metrics-coverage-'))
    const recipe = resolveHostConfig(decodeHostConfig(hostConfig(join(base, 'store')), base))
    const event = createDurableEventDefinition({ type: 'outside-host/known', payloadVersion: 1, ignorable: false, decode: value => value })
    const repository = new SessionRepository({ backend: new FileSessionBackend({ root: recipe.storage.root, maxRecordBytes: recipe.storage.maxRecordBytes }),
      catalog: createDurableEventCatalog([event]), maxLineageDepth: 0 })
    try {
      const unsupported = await repository.create(), empty = await repository.create()
      await unsupported.append(event, {})
      const selected = [unsupported, empty].map(session => ({ sessionId: session.header.sessionId, through: sessionLogPosition(1) }))
      await repository.dispose()
      const limits = { maxSessionCount: 2, maxEvents: 100, maxEvidenceBytes: 1024 * 1024, maxMetricSamples: 32 }
      const collected = await collectExperimentEvidence({ recipe, limits, scope: 'historical-local/v1', mode: 'historical', selected })
      expect([...collected.evidence.coverage.reasons].sort()).toEqual(['SESSION_EVENT_UNSUPPORTED', 'SESSION_POSITION_INVALID'])
      expect(collected.evidence.metrics.coverage.reasons).toHaveLength(4)
      expect(decodeExperimentMetrics(collected.evidence.metrics, limits)).toEqual(collected.evidence.metrics)
      expect(decodeExperimentEvidence(collected.evidence, limits)).toEqual(collected.evidence)
    } finally { await repository.dispose(); await rm(base, { recursive: true, force: true }) }
  })

  it('still rejects a reason vector larger than the event and Session limits permit', () => {
    const metrics = collectExperimentMetrics({ snapshots: [], selectedSessionIds: [], scope: 'historical-local/v1', mode: 'historical', maxMetricSamples: 0,
      coverage: { complete: false, expectedSessions: 0, observedSessions: 0, reasons: Array.from({ length: 5 }, (_, index) => `missing:${index}`) } })
    expect(() => decodeExperimentMetrics(metrics, { maxSessionCount: 1, maxEvents: 1, maxMetricSamples: 0 })).toThrow('coverage-reasons-array')
  })
})

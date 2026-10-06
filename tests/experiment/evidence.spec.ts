import { mkdtemp, appendFile, readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { hostConfig, hostSessionId } from '../host/fixtures.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { parseSessionId } from '../../src/session/ids.js'
import { collectExperimentEvidence, verifyExperimentEvidence } from '../../src/experiment/evidence.js'
import type { ExperimentEvidenceTarget } from '../../src/experiment/evidence-types.js'

const limits = { maxSessionCount: 20, maxEvents: 10000, maxEvidenceBytes: 8 * 1024 * 1024, maxMetricSamples: 64 }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function completedStore() {
  const base = await mkdtemp(join(tmpdir(), 'atomic-experiment-evidence-'))
  roots.push(base)
  const raw = hostConfig(join(base, 'store'))
  const member = (raw.members as readonly JsonObject[])[0]!
  const spec = member.spec as JsonObject
  const config = { ...raw, members: [{ ...member, spec: { ...spec, limits: { ...(spec.limits as JsonObject), maxReportEntries: 0 } } }] }
  const recipe = resolveHostConfig(decodeHostConfig(config, base))
  await initializeHost(recipe)
  const host = await openHost(recipe)
  let target: ExperimentEvidenceTarget
  try {
    const receipt = await host.submitTask('writer', 'Answer the fixed research question')
    const report = await host.run()
    expect(report.members[0]!.agent.roots).toEqual([])
    target = { kind: 'agent', sessionId: parseSessionId(hostSessionId), inputEventId: receipt.eventId,
      selector: { kind: 'root-final' }, mediaType: 'text/plain' }
  } finally { await host.shutdown({ mode: 'drain' }) }
  return { recipe, target }
}

describe('read-only experiment evidence', () => {
  it('finds the exact completed answer when operational report entries are zero', async () => {
    const { recipe, target } = await completedStore()
    const collection = await collectExperimentEvidence({ recipe, limits, scope: 'unit-local/v1', mode: 'fixture', target })
    expect(collection.evidence.coverage.complete).toBe(true)
    expect(collection.evidence.output).toMatchObject({ status: 'available', text: 'fixed answer' })
    expect(collection.evidence.sessions).toHaveLength(1)
    expect(await verifyExperimentEvidence(collection.evidence, limits.maxEvidenceBytes)).toEqual([])
    expect(collection.snapshots[0]!.localPosition).toBe(collection.evidence.sessions[0]!.through)
  })

  it('keeps a valid uncommitted tail out of metrics and binds its physical bytes separately', async () => {
    const { recipe, target } = await completedStore()
    const log = join(recipe.storage.root, 'sessions', hostSessionId, 'events.log')
    const before = await readFile(log)
    await appendFile(log, '12\tabc')
    const input = { recipe, limits, scope: 'unit-local/v1' as const, mode: 'fixture' as const, target }
    const first = await collectExperimentEvidence(input)
    const second = await collectExperimentEvidence(input)
    expect(first.evidence.coverage.complete).toBe(true)
    expect(first.evidence.sessions[0]!.tail).toMatchObject({ byteOffset: before.byteLength, byteLength: 6 })
    expect(first.evidence.metrics).toEqual(second.evidence.metrics)
    expect((await readFile(log)).equals(Buffer.concat([before, Buffer.from('12\tabc')]))).toBe(true)
    await appendFile(log, 'd')
    expect(await verifyExperimentEvidence(first.evidence, limits.maxEvidenceBytes)).toContain(`file-changed:sessions/${hostSessionId}/events.log`)
  })

  it('reports missing roots without creating directories or obtaining a writer', async () => {
    const base = await mkdtemp(join(tmpdir(), 'atomic-experiment-missing-'))
    roots.push(base)
    const recipe = resolveHostConfig(decodeHostConfig(hostConfig(join(base, 'absent')), base))
    const collection = await collectExperimentEvidence({ recipe, limits, scope: 'historical-local/v1', mode: 'historical' })
    expect(collection.evidence.coverage.complete).toBe(false)
    await expect(stat(recipe.storage.root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(collection.evidence.output.status).toBe('unavailable')
  })

  it('rejects oversized physical evidence before decoding the event stream', async () => {
    const { recipe } = await completedStore()
    const collection = await collectExperimentEvidence({ recipe, limits: { ...limits, maxEvidenceBytes: 1 },
      scope: 'historical-local/v1', mode: 'historical' })
    expect(collection.evidence.coverage).toMatchObject({ complete: false, observedSessions: 0, reasons: ['evidence-byte-limit'] })
    expect(collection.snapshots).toEqual([])
  })
})

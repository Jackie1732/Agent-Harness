import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { planExperiment } from '../../src/experiment/definition.js'
import { createExperimentStorage } from '../../src/experiment/storage.js'
import { closeInterruptedExperiment } from '../../src/experiment/administration.js'
import { recordExperimentReport, reportExperiment } from '../../src/experiment/report.js'
import { experimentDefinition } from './definition-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('releases the exact residual controller token after finalization without changing the primary report or Journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-finalized-close-')); roots.push(root)
  const plan = await planExperiment(experimentDefinition(root)), storage = await createExperimentStorage(plan)
  const markerPath = join(plan.storage.controlRoot, '.atomic-harness.lock')
  const marker = await readFile(markerPath), token = storage.lockToken
  const primary = await recordExperimentReport(storage, { reportKey: 'primary', kind: 'primary', finalize: true,
    unstartedReason: 'cancelled-before-start' })
  await storage.dispose()
  await writeFile(markerPath, marker)
  const journalPath = join(plan.storage.controlRoot, 'journal-store', 'sessions', plan.journalSessionId, 'events.log')
  const journalBytes = await readFile(journalPath), reportBytes = await readFile(join(plan.storage.controlRoot, primary.reference.path))

  await expect(closeInterruptedExperiment(plan.storage.controlRoot, { predecessorStopped: true, expectedToken: 'wrong' }))
    .rejects.toThrow('unlock-token-mismatch')
  await expect(closeInterruptedExperiment(plan.storage.controlRoot, { predecessorStopped: true, expectedToken: token, reportKey: 'replacement' }))
    .rejects.toThrow('primary-report-key-changed')
  expect(await readFile(markerPath)).toEqual(marker)

  const closed = await closeInterruptedExperiment(plan.storage.controlRoot, { predecessorStopped: true, expectedToken: token })
  expect(closed.state.position).toBe(primary.state.position)
  expect(closed.report).toEqual(primary.reference)
  await expect(stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  const repeated = await closeInterruptedExperiment(plan.storage.controlRoot, { predecessorStopped: true, expectedToken: token })
  expect(repeated.report).toEqual(primary.reference)
  expect(await readFile(journalPath)).toEqual(journalBytes)
  expect(await readFile(join(plan.storage.controlRoot, primary.reference.path))).toEqual(reportBytes)
  for (const unit of plan.units) await expect(stat(unit.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await reportExperiment(plan.storage.controlRoot, { reportKey: 'later', kind: 'posthoc' })).finalized).toBe(true)
})

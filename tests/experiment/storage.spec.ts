import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createExperimentStorage, openExperimentStorage, publishExperimentFile, readExperimentBootstrap, readExperimentStorage } from '../../src/experiment/storage.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { canonicalJsonBytes } from '../../src/foundation/canonical-json.js'
import type { JsonValue } from '../../src/foundation/json.js'
import { experimentDefinition } from './definition-fixture.js'

const roots: string[] = []
async function root() { const path = await mkdtemp(join(tmpdir(), 'atomic-experiment-storage-')); roots.push(path); return path }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('controlled experiment storage', () => {
  it('publishes immutable inputs and permits pure reads while its controller holds the root lock', async () => {
    const path = await root()
    const plan = await planExperiment(experimentDefinition(path))
    const storage = await createExperimentStorage(plan)
    try {
      const log = join(plan.storage.controlRoot, 'journal-store', 'sessions', plan.journalSessionId, 'events.log')
      const original = await readFile(log)
      const result = await readExperimentStorage(storage.location)
      expect(result.kind).toBe('initialized')
      expect(result.state?.plan).toEqual(plan)
      expect(await readFile(log)).toEqual(original)
      expect((await readFile(join(plan.storage.controlRoot, 'inputs', 'question', 'notes.txt'))).toString()).toBe('The answer is 42.\r\n')
      await expect(openExperimentStorage(storage.location)).rejects.toMatchObject({ code: 'HOST_LOCKED' })
    } finally { await storage.dispose() }
    const reopened = await openExperimentStorage(plan.storage.controlRoot)
    try { expect(reopened.journal.snapshot().plan).toEqual(plan) } finally { await reopened.dispose() }
  })
  it('does not create missing reader directories and distinguishes bootstrap-only storage', async () => {
    const path = await root(), missing = join(path, 'missing')
    expect((await readExperimentStorage(missing)).kind).toBe('uninitialized')
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    const plan = await planExperiment(experimentDefinition(path))
    const storage = await createExperimentStorage(plan)
    await storage.dispose()
    await rm(join(plan.storage.controlRoot, 'journal-store'), { recursive: true })
    const before = await readdir(plan.storage.controlRoot)
    expect((await readExperimentStorage(plan.storage.controlRoot)).kind).toBe('uninitialized')
    expect(await readdir(plan.storage.controlRoot)).toEqual(before)
  })
  it('adopts equal complete publications and rejects changed content and unsafe relative paths', async () => {
    const path = await root()
    const bytes = Buffer.from('{"answer":42}')
    const first = await publishExperimentFile(path, 'reports/report.json', bytes, 1000)
    expect(await publishExperimentFile(path, 'reports/report.json', bytes, 1000)).toEqual(first)
    await expect(publishExperimentFile(path, 'reports/report.json', Buffer.from('different'), 1000)).rejects.toMatchObject({ code: 'EXPERIMENT_CONFLICT' })
    expect(await readFile(join(path, first.path))).toEqual(bytes)
    await expect(publishExperimentFile(path, '../escape.json', bytes, 1000)).rejects.toThrow('publish-path-relative-path')
    await expect(publishExperimentFile(path, 'too-large.json', bytes, 1)).rejects.toMatchObject({ code: 'EXPERIMENT_LIMIT_EXCEEDED' })
  })
  it('rejects an incorrect residual token and reopens only after explicit predecessor-stop confirmation', async () => {
    const path = await root()
    const plan = await planExperiment(experimentDefinition(path))
    const storage = await createExperimentStorage(plan)
    const location = storage.location
    await storage.dispose()
    const marker = join(location.controlRoot, '.atomic-harness.lock')
    const token = 'old-controller-token'
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, hostKey: 'experiment', instanceId: 'stopped', token, processId: 1, acquiredAt: new Date().toISOString() }))
    await expect(openExperimentStorage(location, { expectedToken: token })).rejects.toThrow('predecessor-stop-confirmation-required')
    await expect(openExperimentStorage(location, { predecessorStopped: true, expectedToken: 'different' })).rejects.toMatchObject({ code: 'HOST_LOCKED' })
    const reopened = await openExperimentStorage(location, { predecessorStopped: true, expectedToken: token })
    try { expect(reopened.journal.snapshot().plan?.planDigest).toBe(plan.planDigest) } finally { await reopened.dispose() }
  })
  it('keeps bootstrap identity and Plan digest bound to the actual control root', async () => {
    const path = await root()
    const plan = await planExperiment(experimentDefinition(path))
    const storage = await createExperimentStorage(plan); await storage.dispose()
    const bootstrap = await readExperimentBootstrap(plan.storage.controlRoot)
    await writeFile(join(plan.storage.controlRoot, 'experiment.json'), canonicalJsonBytes({ ...bootstrap, planDigest: 'b'.repeat(64) } as JsonValue))
    await expect(readExperimentStorage(plan.storage.controlRoot)).rejects.toThrow('bootstrap-plan-digest-mismatch')
  })
  it('rejects an escaped output parent before creating directories through a junction', async () => {
    const path = await root(), controlled = join(path, 'control'), outside = join(path, 'outside')
    await mkdir(controlled); await mkdir(outside)
    await symlink(outside, join(controlled, 'reports'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(publishExperimentFile(controlled, 'reports/created/report.json', Buffer.from('{}'), 1000)).rejects.toThrow('published-directory-escapes-root')
    expect(await readdir(outside)).toEqual([])
  })
})

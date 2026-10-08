import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '../src/foundation/json.js'
import { buildHostPreset, buildConfigPreset, configPresetParameters } from '../src/operator/config-presets.js'
import { buildOperatorProfile } from '../src/operator/profile.js'
import { setupOperator, readConfigDocument, createOperatorConfig, exportOperatorConfig, cloneOperatorHost, applyConfigOperations } from '../src/operator/config-operations.js'
import { openAutomationJournal } from '../src/automation/journal.js'
import { decodeAutomationConfig, resolveAutomationConfig } from '../src/automation/config.js'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'operator-config-paths-')); roots.push(root)
  const path = join(root, 'profile.json'), profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' })
  await setupOperator({ profilePath: path, profile, host: buildHostPreset('solo-scripted', { hostKey: 'test-host', storageRoot: join(root, 'store') }) })
  return { root, path }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('native configuration path identity', () => {
  it('keeps the selected profile when a Host export targets its differently cased name', async () => {
    const { root, path } = await fixture(), profile = await readConfigDocument(path, 'operator'), before = await readFile(path)
    const output = join(root, 'PROFILE.JSON')
    if (process.platform === 'win32') {
      await expect(exportOperatorConfig(path, 'host', { output, replace: true, expectedRevision: profile.revision })).rejects.toMatchObject({ message: 'configuration-file-reference-collision' })
    } else {
      expect((await exportOperatorConfig(path, 'host', { output })).executable).toBe(true)
      expect(JSON.parse(await readFile(output, 'utf8')).hostKey).toBe('test-host')
    }
    expect(await readFile(path)).toEqual(before)
  })
  it('keeps the selected profile when Host creation targets its differently cased name', async () => {
    const { root, path } = await fixture(), profile = await readConfigDocument(path, 'operator'), host = await readConfigDocument(path, 'host'), before = await readFile(path)
    const output = join(root, 'PROFILE.JSON')
    if (process.platform === 'win32') {
      await expect(createOperatorConfig(path, 'host', host.value, output, { replace: true, expectedRevision: profile.revision })).rejects.toMatchObject({ message: 'configuration-file-reference-collision' })
      expect(await readFile(path)).toEqual(before)
    } else {
      expect((await createOperatorConfig(path, 'host', host.value, output)).failure).toBeNull()
      expect((await readConfigDocument(path, 'operator')).value).toMatchObject({ profileKey: (profile.value as JsonObject).profileKey })
      expect((await readConfigDocument(path, 'host')).path).toBe(output)
    }
  })
  it('keeps the source Host when clone targets its differently cased name', async () => {
    const { root, path } = await fixture(), host = await readConfigDocument(path, 'host'), before = await readFile(host.path)
    const options = { newStorage: join(root, 'clone-store'), output: join(root, 'HOST.JSON'), hostKey: 'clone-host' }
    if (process.platform === 'win32') {
      await expect(cloneOperatorHost(path, { ...options, replace: true, expectedRevision: host.revision })).rejects.toMatchObject({ message: 'configuration-file-reference-collision' })
    } else {
      expect((await cloneOperatorHost(path, options)).document.path).toBe(options.output)
    }
    expect(await readFile(host.path)).toEqual(before)
  })
  it('requires clone storage to differ under the native directory rules', async () => {
    const { root, path } = await fixture(), host = await readConfigDocument(path, 'host'), before = await readFile(host.path)
    const options = { newStorage: join(root, 'STORE'), output: join(root, 'clone.json'), hostKey: 'clone-host' }
    if (process.platform === 'win32') {
      await expect(cloneOperatorHost(path, options)).rejects.toMatchObject({ message: 'clone-storage-must-change' })
      await expect(stat(options.output)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(((await cloneOperatorHost(path, options)).document.value as JsonObject).storage).toMatchObject({ root: options.newStorage })
    }
    expect(await readFile(host.path)).toEqual(before)
  })
  it('refuses setup file collisions before either configuration is published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-setup-paths-')); roots.push(root)
    const path = join(root, 'profile.json'), profile = buildOperatorProfile({ kind: 'local', hostConfig: './PROFILE.JSON', shutdownMode: 'cancel' })
    const setup = { profilePath: path, profile, host: buildHostPreset('solo-scripted', { hostKey: 'test-host', storageRoot: join(root, 'store') }) }
    if (process.platform === 'win32') {
      await expect(setupOperator(setup)).rejects.toMatchObject({ message: 'setup-file-reference-collision' })
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect((await setupOperator(setup)).failure).toBeNull()
      expect((await readConfigDocument(path, 'host')).path).toBe(join(root, 'PROFILE.JSON'))
    }
  })
  it('preserves an initialized Automation journal when its root changes only in letter case', async () => {
    const { root, path } = await fixture(), params = configPresetParameters('automation', 'webhook', root)
    const candidate = buildConfigPreset('automation', 'webhook', { ...params, journalRoot: join(root, 'automation-journal') }, root)
    await createOperatorConfig(path, 'automation', candidate, join(root, 'automation.json'))
    const document = await readConfigDocument(path, 'automation'), config = resolveAutomationConfig(decodeAutomationConfig(document.value), root)
    const journal = await openAutomationJournal(config); await journal.dispose()
    const before = await readFile(document.path), events = join(config.journal.root, 'sessions', config.journal.sessionId, 'events.log'), eventBytes = await readFile(events)
    const changes = [{ op: 'set' as const, pointer: '/journal/root', value: join(root, 'AUTOMATION-JOURNAL') },
      { op: 'set' as const, pointer: '/limits/observeIntervalMs', value: 500 }]
    if (process.platform === 'win32') {
      await expect(applyConfigOperations(path, 'automation', changes, { expectedRevision: document.revision })).rejects.toMatchObject({ message: 'automation-config-requires-new-journal' })
      expect(await readFile(document.path)).toEqual(before)
    } else {
      expect((await applyConfigOperations(path, 'automation', changes, { expectedRevision: document.revision })).diff.effect).toBe('new-journal')
    }
    expect(await readFile(events)).toEqual(eventBytes)
  })
})

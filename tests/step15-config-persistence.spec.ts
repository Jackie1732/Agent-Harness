import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '../src/foundation/json.js'
import { buildHostPreset } from '../src/operator/config-presets.js'
import { buildOperatorProfile, readOperatorProfile } from '../src/operator/profile.js'
import { openOperatorJournal } from '../src/operator/intents.js'
import { setupOperator, createOperatorConfig, readConfigDocument, applyConfigOperations, planOperatorHost, configReadiness } from '../src/operator/config-operations.js'
import { openAutomationJournal } from '../src/automation/journal.js'
import { config as automationConfig } from './automation/fixtures.js'
import { runnableWorkflowConfig } from './workflow/host-fixture.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import { initializeHost } from '../src/host/initialization.js'
import { uiConfig } from './ui/fixtures.js'

const roots: string[] = []
async function fixture(hostValue?: (root: string) => JsonValue) {
  const root = await mkdtemp(join(tmpdir(), 'operator-config-persistence-')); roots.push(root)
  const path = join(root, 'profile.json'), profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' })
  await setupOperator({ profilePath: path, profile, host: hostValue?.(root) ?? buildHostPreset('solo-scripted', { hostKey: 'test-host', storageRoot: join(root, 'store') }) })
  return { root, path }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('configuration changes retain persistent owner restrictions', () => {
  it('protects established profile identity and authentication references while allowing preferences and a fresh journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-config-identity-')); roots.push(root)
    const path = join(root, 'profile.json'), remote = uiConfig(8443).remote
    const profile = buildOperatorProfile({ kind: 'remote', origin: remote.origin, serverName: remote.serverName ?? null,
      tlsFiles: { ca: remote.caFile, cert: remote.certFile, key: remote.keyFile }, limits: remote.limits,
      targets: { agentKeys: ['writer'], workflowKeys: [] } })
    await setupOperator({ profilePath: path, profile, host: null })
    const current = (await readOperatorProfile(path)).profile, journal = await openOperatorJournal(current, 'a'.repeat(64))
    try { expect(journal.journal.healthy).toBe(true) } finally { await journal.dispose() }
    const document = await readConfigDocument(path, 'operator'), events = join(current.journal.root, 'sessions', current.journal.sessionId, 'events.log'), bytes = await readFile(events)
    const edits = [
      ['/profileKey', '40000000-0000-4000-8000-000000000020'], ['/connection/origin', 'https://127.0.0.1:9443'],
      ['/connection/tlsFiles/ca', './another-ca.pem'], ['/connection/tlsFiles/cert', './another-cert.pem'], ['/connection/tlsFiles/key', './another-key.pem'],
      ['/connection', { kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' }],
    ] as const
    for (const [pointer, value] of edits) await expect(applyConfigOperations(path, 'operator', [{ op: 'set', pointer, value }],
      { expectedRevision: document.revision })).rejects.toMatchObject({ message: 'operator-journal-identity-bound' })
    expect((await readConfigDocument(path, 'operator')).revision).toBe(document.revision)
    const preferences = await applyConfigOperations(path, 'operator', [{ op: 'set', pointer: '/display/maxTextBytes', value: 32768 },
      { op: 'set', pointer: '/journal/maxRecordBytes', value: 4 * 1024 * 1024 }], { expectedRevision: document.revision })
    const fresh = await applyConfigOperations(path, 'operator', [{ op: 'set', pointer: '/connection/origin', value: 'https://127.0.0.1:9443' },
      { op: 'set', pointer: '/journal/sessionId', value: '40000000-0000-4000-8000-000000000021' }], { expectedRevision: preferences.document.revision })
    expect(fresh.diff.effect).toBe('new-journal')
    expect(await readFile(events)).toEqual(bytes)
  })
  it('requires a new journal when an initialized Automation configuration changes', async () => {
    const { root, path } = await fixture(), host = await readConfigDocument(path, 'host')
    await planOperatorHost(path, { expectedRevision: host.revision })
    const candidate = automationConfig(root, 8443)
    await createOperatorConfig(path, 'automation', candidate as unknown as JsonValue, join(root, 'automation.json'))
    const journal = await openAutomationJournal(candidate); await journal.dispose()
    const document = await readConfigDocument(path, 'automation'), before = await readFile(join(candidate.journal.root, 'sessions', candidate.journal.sessionId, 'events.log'))
    await expect(applyConfigOperations(path, 'automation', [{ op: 'set', pointer: '/limits/observeIntervalMs', value: 500 }], { expectedRevision: document.revision })).rejects.toMatchObject({ message: 'automation-config-requires-new-journal' })
    expect((await readConfigDocument(path, 'automation')).revision).toBe(document.revision)
    const edited = await applyConfigOperations(path, 'automation', [
      { op: 'set', pointer: '/limits/observeIntervalMs', value: 500 }, { op: 'set', pointer: '/journal/sessionId', value: '40000000-0000-4000-8000-000000000015' },
    ], { expectedRevision: document.revision })
    expect(edited.diff.effect).toBe('new-journal')
    expect(await readFile(join(candidate.journal.root, 'sessions', candidate.journal.sessionId, 'events.log'))).toEqual(before)
  })
  it('detects removed coordinator inventory through the original discovery check', async () => {
    const { root, path } = await fixture(root => runnableWorkflowConfig(join(root, 'store')) as unknown as JsonValue)
    const document = await readConfigDocument(path, 'host'), host = resolveHostConfig(decodeHostConfig(document.value, root)); await initializeHost(host)
    const saved = await applyConfigOperations(path, 'host', [{ op: 'set', pointer: '/workflows', value: { kind: 'disabled' } }], { expectedRevision: document.revision })
    expect(saved.diff.binding).toBe('incompatible')
    expect(saved.diff.reason).toBe('workflow-config-removed')
    const evidence = await configReadiness(path, 'host', {})
    expect(evidence.status).toBe('not-ready')
    expect(evidence.evidence).toContainEqual({ subject: 'host.bindings', status: 'incompatible', reason: 'workflow-config-removed' })
  })
  it('classifies runner-only changes through the same persisted member comparison', async () => {
    const { root, path } = await fixture(), document = await readConfigDocument(path, 'host')
    const planned = await planOperatorHost(path, { expectedRevision: document.revision }), host = resolveHostConfig(decodeHostConfig(planned.document.value, root))
    await initializeHost(host)
    const result = await applyConfigOperations(path, 'host', [{ op: 'set', pointer: '/members/0/model/runnerLimits/maxJournalConflicts', value: 8 }], { expectedRevision: planned.document.revision })
    expect(result.diff.binding).toBe('compatible')
    expect(result.diff.effect).toBe('restart')
  })
})
